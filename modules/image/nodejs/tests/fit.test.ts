import type { ResourceContext } from "@telorun/sdk";
import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@napi-rs/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@napi-rs/canvas")>();
  return { ...actual, loadImage: vi.fn(actual.loadImage) };
});

const { createCanvas, loadImage } = await import("@napi-rs/canvas");
const { create } = await import("../src/fit-controller.js");

const fixture = async (name: string) =>
  new Uint8Array(await readFile(new URL(`../../tests/__fixtures__/${name}`, import.meta.url)));

const fit = (resource: Record<string, unknown> = {}) =>
  create({ metadata: { name: "fit" }, ...resource }, {} as ResourceContext);

const RED = "#ff0000";
const GREEN = "#00ff00";
const BLUE = "#0000ff";
const WHITE = "#ffffff";

/** A 40 × 20 JPEG whose four quarters are one colour each. */
function quarters(): Uint8Array {
  const canvas = createCanvas(40, 20);
  const ctx = canvas.getContext("2d");
  const fill = (color: string, x: number, y: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 20, 10);
  };
  fill(RED, 0, 0);
  fill(GREEN, 20, 0);
  fill(BLUE, 0, 10);
  fill(WHITE, 20, 10);
  return new Uint8Array(canvas.toBuffer("image/jpeg", 95));
}

/** `jpeg` with an EXIF block saying how it is to be turned. */
function oriented(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, body.length + 2, ...body, ...jpeg.subarray(2)]);
}

/** The colour nearest each corner of an encoded image, as TL, TR, BL, BR. */
async function corners(image: Uint8Array): Promise<string[]> {
  const decoded = await loadImage(image);
  const canvas = createCanvas(decoded.width, decoded.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const near = (x: number, y: number) => {
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    return "#" + [r, g, b].map((channel) => (channel > 127 ? "ff" : "00")).join("");
  };
  const right = decoded.width - 3;
  const bottom = decoded.height - 3;
  return [near(2, 2), near(right, 2), near(2, bottom), near(right, bottom)];
}

beforeEach(() => {
  vi.mocked(loadImage).mockClear();
});

// What stands in each upright corner (TL, TR, BL, BR), per EXIF orientation,
// for an image stored with red, green, blue and white in those corners.
it.each([
  [1, [RED, GREEN, BLUE, WHITE], 40, 20],
  [2, [GREEN, RED, WHITE, BLUE], 40, 20],
  [3, [WHITE, BLUE, GREEN, RED], 40, 20],
  [4, [BLUE, WHITE, RED, GREEN], 40, 20],
  [5, [RED, BLUE, GREEN, WHITE], 20, 40],
  [6, [BLUE, RED, WHITE, GREEN], 20, 40],
  [7, [WHITE, GREEN, BLUE, RED], 20, 40],
  [8, [GREEN, WHITE, RED, BLUE], 20, 40],
])("turns a JPEG of orientation %i upright exactly once", async (orientation, expected, width, height) => {
  const result = await (await fit()).invoke({
    image: oriented(quarters(), orientation),
    maxWidth: 100,
    maxHeight: 100,
  });

  expect(result).toMatchObject({ width, height });
  expect(await corners(result.image)).toEqual(expected);
});

// Stored 40 × 20, red on the left and blue on the right, tagged orientation 6:
// upright it is 20 × 40 with red on top.
it.each(["webp", "png"])("turns a %s upright by its EXIF orientation exactly once", async (format) => {
  const result = await (await fit()).invoke({
    image: await fixture(`orientation-6.${format}`),
    maxWidth: 100,
    maxHeight: 100,
  });

  expect(result).toMatchObject({ width: 20, height: 40 });
  expect(await corners(result.image)).toEqual([RED, RED, BLUE, BLUE]);
});

it("yields the first frame of an animated GIF", async () => {
  const result = await (await fit()).invoke({
    image: await fixture("two-frames.gif"),
    maxWidth: 64,
    maxHeight: 64,
  });

  expect(result).toMatchObject({ width: 4, height: 4, mediaType: "image/png" });
  expect(await corners(result.image)).toEqual([RED, RED, RED, RED]);
});

it("carries no input metadata into the output", async () => {
  const result = await (await fit()).invoke({
    image: await fixture("orientation-6.jpg"),
    maxWidth: 100,
    maxHeight: 100,
    format: "jpeg",
  });
  expect(Buffer.from(result.image).includes("Exif")).toBe(false);
});

it("refuses an image declaring more pixels than maxPixels without decoding it", async () => {
  await expect(
    (await fit()).invoke({
      image: await fixture("declares-30000x30000.png"),
      maxWidth: 512,
      maxHeight: 512,
    }),
  ).rejects.toMatchObject({ code: "ERR_IMAGE_TOO_LARGE", data: { limit: "maxPixels", max: 40000000 } });
  expect(loadImage).not.toHaveBeenCalled();
});

it("refuses an image over maxBytes before reading its header", async () => {
  await expect(
    (await fit({ maxBytes: 16 })).invoke({ image: new Uint8Array(17), maxWidth: 512, maxHeight: 512 }),
  ).rejects.toMatchObject({ code: "ERR_IMAGE_TOO_LARGE", data: { limit: "maxBytes", max: 16 } });
  expect(loadImage).not.toHaveBeenCalled();
});

it.each([
  ["a truncated PNG", () => new Uint8Array(createCanvas(64, 64).toBuffer("image/png")).subarray(0, 60)],
  ["a truncated JPEG", () => {
    const jpeg = new Uint8Array(createCanvas(64, 64).toBuffer("image/jpeg", 90));
    return jpeg.subarray(0, jpeg.byteLength - 40);
  }],
  ["a truncated WebP", () => new Uint8Array(createCanvas(64, 64).toBuffer("image/webp", 90)).subarray(0, 100)],
  ["a PNG whose header dimensions were altered", () => {
    const png = new Uint8Array(createCanvas(64, 64).toBuffer("image/png"));
    new DataView(png.buffer).setUint32(16, 100);
    return png;
  }],
])("refuses %s as unsupported once the decoder rejects it", async (name, corrupt) => {
  await expect(
    (await fit()).invoke({ image: await corrupt(), maxWidth: 512, maxHeight: 512 }),
  ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_IMAGE" });
  expect(loadImage).toHaveBeenCalledTimes(1);
});

// A decoder draws a GIF frame cut short as far as it got, so that is refused
// from the frame's own block lengths.
it("refuses a GIF cut inside its first frame without decoding it", async () => {
  await expect(
    (await fit()).invoke({
      image: (await fixture("two-frames.gif")).subarray(0, 66),
      maxWidth: 512,
      maxHeight: 512,
    }),
  ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_IMAGE" });
  expect(loadImage).not.toHaveBeenCalled();
});
