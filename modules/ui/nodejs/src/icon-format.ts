import { RuntimeError } from "@telorun/sdk";

/** An image format a browser can use as a mask. */
export interface IconFormat {
  extension: string;
  mediaType: string;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SVG_START = /^﻿?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/;

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** A glyph file's format, read from its own bytes: an SVG, PNG or WebP image. */
export function iconFormat(bytes: Uint8Array): IconFormat | undefined {
  if (PNG.every((byte, index) => bytes[index] === byte)) return { extension: "png", mediaType: "image/png" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { extension: "webp", mediaType: "image/webp" };
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  if (SVG_START.test(head)) return { extension: "svg", mediaType: "image/svg+xml" };
  return undefined;
}

/** The format of an icon's file, refused when a browser could not draw it as a glyph. */
export function servedIconFormat(bytes: Uint8Array, file: string, owner: string, where: string): IconFormat {
  const format = iconFormat(bytes);
  if (format) return format;
  throw new RuntimeError(
    "ERR_UI_ICON_FORMAT_UNKNOWN",
    `${owner}: the icon of '${where}' is drawn from '${file}', which is not an SVG, PNG or WebP image, so a browser cannot draw it as a glyph. Point the icon at an SVG, PNG or WebP file.`,
  );
}
