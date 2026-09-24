/**
 * The image formats the bundled engine decodes, recognized by their leading bytes,
 * and their pixel size read from the header alone — so a size limit is enforced
 * before anything is decoded, and a format the engine cannot read never reaches it.
 */

export type ImageFormat = "png" | "jpeg" | "webp" | "bmp" | "pnm";

export interface ImageHeader {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

/** Why a header could not be read; its message is what the caller reports. */
export class ImageHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageHeaderError";
  }
}

const ACCEPTED = "PNG, JPEG, WebP, BMP or PNM";

export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header =
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? readPng(bytes, view)
      : startsWith(bytes, [0xff, 0xd8, 0xff])
        ? readJpeg(bytes, view)
        : startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
          ? readWebp(bytes, view)
          : startsWith(bytes, ascii("BM"))
            ? readBmp(bytes, view)
            : bytes.length >= 2 && bytes[0] === 0x50 && bytes[1]! >= 0x31 && bytes[1]! <= 0x36
              ? readPnm(bytes)
              : undefined;
  if (header === undefined) {
    throw new ImageHeaderError(`${describeUnknown(bytes)}; only ${ACCEPTED} images are read.`);
  }
  if (header.width < 1 || header.height < 1) {
    throw new ImageHeaderError(
      `The ${header.format.toUpperCase()} header declares a ${header.width}x${header.height} image.`,
    );
  }
  return header;
}

function readPng(bytes: Uint8Array, view: DataView): ImageHeader {
  need(bytes, 24, "PNG");
  if (!startsWith(bytes, ascii("IHDR"), 12)) {
    throw new ImageHeaderError("The PNG does not start with its IHDR chunk.");
  }
  return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
}

// Every start-of-frame marker carries the size; DHT (C4), JPG (C8) and DAC (CC)
// share the range and do not.
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(bytes: Uint8Array, view: DataView): ImageHeader {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new ImageHeaderError(`The JPEG has no marker at byte ${offset}.`);
    }
    // Fill bytes before a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) {
      throw new ImageHeaderError("The JPEG reaches its image data before declaring a frame size.");
    }
    need(bytes, offset + 2, "JPEG");
    const length = view.getUint16(offset);
    if (JPEG_FRAME_MARKERS.has(marker)) {
      need(bytes, offset + 7, "JPEG");
      return { format: "jpeg", height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    if (length < 2) throw new ImageHeaderError(`The JPEG has a malformed segment at byte ${offset}.`);
    offset += length;
  }
  throw new ImageHeaderError("The JPEG header is truncated before its frame size.");
}

function readWebp(bytes: Uint8Array, view: DataView): ImageHeader {
  need(bytes, 16, "WebP");
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 ") {
    need(bytes, 30, "WebP");
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new ImageHeaderError("The WebP lossy frame has no start code.");
    }
    return {
      format: "webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    need(bytes, 25, "WebP");
    if (bytes[20] !== 0x2f) throw new ImageHeaderError("The WebP lossless frame has no signature.");
    const bits = view.getUint32(21, true);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    need(bytes, 30, "WebP");
    return { format: "webp", width: uint24(bytes, 24) + 1, height: uint24(bytes, 27) + 1 };
  }
  throw new ImageHeaderError(`The WebP starts with an unknown '${chunk}' chunk.`);
}

function readBmp(bytes: Uint8Array, view: DataView): ImageHeader {
  need(bytes, 18, "BMP");
  const infoSize = view.getUint32(14, true);
  if (infoSize === 12) {
    need(bytes, 22, "BMP");
    return { format: "bmp", width: view.getUint16(18, true), height: view.getUint16(20, true) };
  }
  if (infoSize < 40) throw new ImageHeaderError(`The BMP has an unknown ${infoSize}-byte info header.`);
  need(bytes, 26, "BMP");
  // A negative height is a top-down bitmap of the same size.
  return {
    format: "bmp",
    width: view.getInt32(18, true),
    height: Math.abs(view.getInt32(22, true)),
  };
}

function readPnm(bytes: Uint8Array): ImageHeader {
  const fields: number[] = [];
  let offset = 2;
  while (fields.length < 2) {
    while (offset < bytes.length && isSpace(bytes[offset]!)) offset++;
    if (offset < bytes.length && bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) offset++;
      continue;
    }
    const start = offset;
    while (offset < bytes.length && bytes[offset]! >= 0x30 && bytes[offset]! <= 0x39) offset++;
    if (offset === start || offset >= bytes.length) {
      throw new ImageHeaderError(
        offset >= bytes.length
          ? "The PNM header is truncated before its size."
          : `The PNM header has no number at byte ${start}.`,
      );
    }
    fields.push(Number(String.fromCharCode(...bytes.subarray(start, offset))));
  }
  return { format: "pnm", width: fields[0]!, height: fields[1]! };
}

function need(bytes: Uint8Array, length: number, format: string): void {
  if (bytes.length < length) {
    throw new ImageHeaderError(`The ${format} header is truncated (${bytes.length} bytes).`);
  }
}

function describeUnknown(bytes: Uint8Array): string {
  if (bytes.length === 0) return "The image is empty";
  if (startsWith(bytes, ascii("GIF8"))) return "The image is a GIF";
  if (startsWith(bytes, ascii("ftyp"), 4)) return "The image is an ISO media file (AVIF or HEIF)";
  if (startsWith(bytes, ascii("%PDF"))) {
    return "The bytes are a PDF, which is not an image — render its pages to images first";
  }
  return "The bytes are not a recognized image format";
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function uint24(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}
