import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { readImageHeader } from "../src/image-header.js";

/**
 * `maxPixels` is judged on what the header reader reports, so a file must never
 * decode to more pixels than that. These two files say one size where the
 * reader looks and carry another where the decoder might.
 */

function canvas200x100() {
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 200, 100);
  return canvas;
}

/** Pixels the decoder produces, or 0 when it refuses the file. */
async function decodedPixels(bytes: Uint8Array): Promise<number> {
  try {
    const image = await loadImage(bytes);
    return image.width * image.height;
  } catch {
    return 0;
  }
}

const judgedPixels = (bytes: Uint8Array) => {
  const header = readImageHeader(bytes);
  return header.width * header.height;
};

it("never decodes a WebP whose extended-format canvas is smaller than its frame to more than was judged", async () => {
  const webp = new Uint8Array(canvas200x100().toBuffer("image/webp", 80));
  expect(String.fromCharCode(...webp.subarray(12, 16))).toBe("VP8X");
  expect(judgedPixels(webp)).toBe(200 * 100);
  // The canvas size, two 24-bit fields each holding one less than the size.
  webp.set([9, 0, 0, 9, 0, 0], 24);

  expect(judgedPixels(webp)).toBe(10 * 10);
  expect(await decodedPixels(webp)).toBeLessThanOrEqual(10 * 10);
});

it("never decodes a JPEG carrying a second frame header to more than was judged", async () => {
  const jpeg = new Uint8Array(canvas200x100().toBuffer("image/jpeg", 80));
  let frame = 2;
  while (jpeg[frame + 1] !== 0xc0 && jpeg[frame + 1] !== 0xc2) {
    frame += 2 + ((jpeg[frame + 2]! << 8) | jpeg[frame + 3]!);
  }
  // A 10 × 10 baseline frame header, put ahead of the real 200 × 100 one.
  const small = [0xff, 0xc0, 0, 17, 8, 0, 10, 0, 10, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const twoFrames = Uint8Array.from([...jpeg.subarray(0, frame), ...small, ...jpeg.subarray(frame)]);

  expect(judgedPixels(twoFrames)).toBe(10 * 10);
  expect(await decodedPixels(twoFrames)).toBeLessThanOrEqual(10 * 10);
});
