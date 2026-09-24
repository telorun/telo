import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ImageHeaderError, readImageHeader } from "../src/image-header.js";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../tests/__fixtures__/${name}`, import.meta.url)));

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));
const u16be = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => u32be(n).reverse();

const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(640), u32be(480), [8, 2, 0, 0, 0]);
// A JFIF APP0 segment ahead of a progressive frame (SOF2), behind a fill byte.
const jpeg = bytes(
  [0xff, 0xd8, 0xff, 0xe0], u16be(16), "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xff, 0xc2], u16be(17), [8], u16be(300), u16be(400), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
);
const webpLossy = bytes("RIFF", u32le(30), "WEBP", "VP8 ", u32le(18), [0, 0, 0, 0x9d, 0x01, 0x2a], u16le(321), u16le(123), [0, 0]);
const webpLossless = bytes("RIFF", u32le(26), "WEBP", "VP8L", u32le(5), [0x2f], u32le((200 - 1) | ((100 - 1) << 14)));
const webpExtended = bytes("RIFF", u32le(30), "WEBP", "VP8X", u32le(10), [0, 0, 0, 0], [0xff, 0x03, 0], [0xc7, 0x01, 0]);
const bmpCore = bytes("BM", u32le(0), u32le(0), u32le(26), u32le(12), u16le(77), u16le(55), u16le(1), u16le(24));

describe("readImageHeader", () => {
  it.each([
    ["png", png, { format: "png", width: 640, height: 480 }],
    ["jpeg", jpeg, { format: "jpeg", width: 400, height: 300 }],
    ["lossy webp", webpLossy, { format: "webp", width: 321, height: 123 }],
    ["lossless webp", webpLossless, { format: "webp", width: 200, height: 100 }],
    ["extended webp", webpExtended, { format: "webp", width: 1024, height: 456 }],
    ["24-bit bmp", fixture("hello.bmp"), { format: "bmp", width: 560, height: 48 }],
    ["OS/2 bmp", bmpCore, { format: "bmp", width: 77, height: 55 }],
    ["pnm with a comment", fixture("hello.pnm"), { format: "pnm", width: 560, height: 48 }],
    ["png fixture", fixture("rotated.png"), { format: "png", width: 260, height: 600 }],
  ])("reads the size of a %s", (_, image, header) => {
    expect(readImageHeader(image)).toEqual(header);
  });

  it.each([
    ["png", png, 20],
    ["jpeg", jpeg, 24],
    ["lossy webp", webpLossy, 27],
    ["lossless webp", webpLossless, 22],
    ["extended webp", webpExtended, 28],
    ["bmp", fixture("hello.bmp"), 20],
    ["pnm", fixture("hello.pnm"), 30],
  ])("refuses a truncated %s", (_, image, length) => {
    expect(() => readImageHeader(image.subarray(0, length))).toThrow(ImageHeaderError);
  });

  it.each([
    ["an empty input", new Uint8Array(), "The image is empty"],
    ["a GIF", bytes("GIF89a", u16le(1), u16le(1)), "The image is a GIF"],
    ["an AVIF", bytes(u32be(24), "ftypavif"), "AVIF"],
    ["a PDF", bytes("%PDF-1.7\n"), "render its pages to images first"],
    ["text", bytes("not an image"), "not a recognized image format"],
  ])("refuses %s", (_, image, message) => {
    expect(() => readImageHeader(image)).toThrow(message);
  });
});
