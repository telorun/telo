import { createCanvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { expect, it } from "vitest";
import { ImageHeaderError, readImageHeader, withUprightTag } from "../src/image-header.js";

const fixture = async (name: string) =>
  new Uint8Array(await readFile(new URL(`../../tests/__fixtures__/${name}`, import.meta.url)));

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const encoded = (format: "png" | "jpeg" | "webp") =>
  new Uint8Array(createCanvas(37, 21).toBuffer(`image/${format}` as "image/png"));

it.each(["png", "jpeg", "webp"] as const)("reads the size of an encoded %s", (format) => {
  expect(readImageHeader(encoded(format))).toMatchObject({ format, width: 37, height: 21 });
});

it("reads the size a PNG declares without needing its pixels", async () => {
  expect(readImageHeader(await fixture("declares-30000x30000.png"))).toEqual({
    format: "png",
    width: 30000,
    height: 30000,
  });
});

it("reads a lossy and a lossless WebP frame header", () => {
  const riff = (chunk: string, payload: number[]) =>
    Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), 0, 0, 0, 0, ...payload]);
  // 300 × 200, each a little-endian 14-bit field.
  const lossy = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00]);
  // (width − 1) | (height − 1) << 14, after the 0x2f signature.
  const bits = 299 | (199 << 14);
  const lossless = riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]);

  expect(readImageHeader(lossy)).toMatchObject({ format: "webp", width: 300, height: 200 });
  expect(readImageHeader(lossless)).toMatchObject({ format: "webp", width: 300, height: 200 });
});

it("reads a GIF's size, taking a first frame that reaches past the declared screen", async () => {
  const gif = await fixture("two-frames.gif");
  expect(readImageHeader(gif)).toEqual({ format: "gif", width: 4, height: 4 });

  const reaching = new Uint8Array(gif);
  const descriptor = reaching.indexOf(0x2c, 13 + 12);
  // The frame's width, 4, becomes 3000.
  reaching[descriptor + 5] = 0xb8;
  reaching[descriptor + 6] = 0x0b;
  expect(readImageHeader(reaching)).toEqual({ format: "gif", width: 3000, height: 4 });
});

it("finds a JPEG's orientation tag and can rewrite it as upright", async () => {
  const jpeg = await fixture("orientation-6.jpg");
  const header = readImageHeader(jpeg);
  expect(header).toMatchObject({ format: "jpeg", width: 40, height: 20, orientation: { value: 6 } });

  const upright = withUprightTag(jpeg, header.orientation!);
  expect(readImageHeader(upright).orientation).toBeUndefined();
  expect(upright.byteLength).toBe(jpeg.byteLength);
  expect(readImageHeader(jpeg).orientation?.value).toBe(6);
});

it("finds the orientation tag in a WebP's EXIF chunk", () => {
  const webp = encoded("webp");
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0];
  const tagged = Uint8Array.from([...webp, ...ascii("EXIF"), tiff.length, 0, 0, 0, ...tiff]);

  expect(readImageHeader(tagged).orientation).toMatchObject({ value: 8, littleEndian: true });
  expect(readImageHeader(withUprightTag(tagged, readImageHeader(tagged).orientation!)).orientation)
    .toBeUndefined();
});

it("finds the orientation tag in a PNG's eXIf chunk and rewrites it with a valid checksum", async () => {
  const png = await fixture("orientation-6.png");
  const header = readImageHeader(png);
  expect(header).toMatchObject({ format: "png", width: 40, height: 20, orientation: { value: 6 } });

  const upright = withUprightTag(png, header.orientation!);
  expect(readImageHeader(upright).orientation).toBeUndefined();
  // The chunk sits after IHDR: length at 33, type at 37, 26 data bytes, then its CRC.
  const chunk = Buffer.from(upright.subarray(37, 37 + 4 + 26));
  expect(new DataView(upright.buffer).getUint32(37 + 4 + 26)).toBe(crc32(chunk));
});

it.each([
  ["a PDF", Uint8Array.from(ascii("%PDF-1.7\n")), /PDF/],
  ["no bytes", new Uint8Array(0), /empty/],
  ["a PNG cut inside its header", encoded("png").subarray(0, 20), /truncated/],
  ["a JPEG cut before its image data", encoded("jpeg").subarray(0, 60), /truncated/],
  ["a GIF with no frame", Uint8Array.from([...ascii("GIF89a"), 4, 0, 4, 0, 0, 0, 0, 0x3b]), /no frame/],
  ["a PNG declaring no pixels", (() => {
    const png = encoded("png");
    png.fill(0, 16, 20);
    return png;
  })(), /0x21/],
])("refuses %s", (name, bytes, reason) => {
  expect(() => readImageHeader(bytes)).toThrow(ImageHeaderError);
  expect(() => readImageHeader(bytes)).toThrow(reason);
});
