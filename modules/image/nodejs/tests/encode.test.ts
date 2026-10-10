import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { encodeCanvas } from "../src/encode.js";
import { readImageHeader } from "../src/image-header.js";

it.each([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
] as const)("encodes a canvas as %s that decodes to the canvas's size", async (format, mediaType) => {
  const encoded = await encodeCanvas(createCanvas(37, 21), { format, quality: 60 }, {}, "test");

  expect(encoded.mediaType).toBe(mediaType);
  expect(readImageHeader(encoded.image).format).toBe(format);
  const decoded = await loadImage(encoded.image);
  expect([decoded.width, decoded.height]).toEqual([37, 21]);
});
