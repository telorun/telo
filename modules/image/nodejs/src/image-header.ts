/**
 * What an encoded image declares about itself, read from its header alone:
 * the format, the stored pixel size and where its EXIF orientation is written.
 * Nothing here decodes a pixel, so a limit is enforced before a decoder runs.
 */

export type SourceFormat = "png" | "jpeg" | "webp" | "gif";

/** An EXIF orientation tag: its value (2–8) and where its two bytes sit. */
export interface OrientationTag {
  readonly value: number;
  readonly offset: number;
  readonly littleEndian: boolean;
  /** The checksummed chunk holding the tag, when its container has one. */
  readonly chunk?: ChecksummedChunk;
}

/** A PNG chunk: where its type and data start, and how long the data is. */
interface ChecksummedChunk {
  readonly start: number;
  readonly dataLength: number;
}

export interface ImageHeader {
  readonly format: SourceFormat;
  /** Pixel size as stored, before any orientation is applied. */
  readonly width: number;
  readonly height: number;
  /** Present for a JPEG, WebP or PNG carrying an orientation other than upright. */
  readonly orientation?: OrientationTag;
}

/** Why a header could not be read; its message is what the caller reports. */
export class ImageHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageHeaderError";
  }
}

export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? readPng(bytes, view)
    : startsWith(bytes, [0xff, 0xd8, 0xff])
      ? readJpeg(bytes, view)
      : startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
        ? readWebp(bytes, view)
        : startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))
          ? readGif(bytes, view)
          : undefined;
  if (header === undefined) {
    throw new ImageHeaderError(
      `${describeUnknown(bytes)}; only PNG, JPEG, WebP and GIF images are read.`,
    );
  }
  if (header.width < 1 || header.height < 1) {
    throw new ImageHeaderError(
      `The ${header.format.toUpperCase()} header declares a ${header.width}x${header.height} image.`,
    );
  }
  return header;
}

/** A copy of `bytes` whose orientation tag reads upright, so that a decoder
 *  that honours the tag and one that ignores it produce the same pixels. */
export function withUprightTag(bytes: Uint8Array, tag: OrientationTag): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[tag.offset] = tag.littleEndian ? 1 : 0;
  copy[tag.offset + 1] = tag.littleEndian ? 0 : 1;
  if (tag.chunk !== undefined) {
    const { start, dataLength } = tag.chunk;
    const end = start + 4 + dataLength;
    new DataView(copy.buffer).setUint32(end, crc32(copy.subarray(start, end)));
  }
  return copy;
}

function readPng(bytes: Uint8Array, view: DataView): ImageHeader {
  need(bytes, 24, "PNG");
  if (!startsWith(bytes, ascii("IHDR"), 12)) {
    throw new ImageHeaderError("The PNG does not start with its IHDR chunk.");
  }
  return {
    format: "png",
    width: view.getUint32(16),
    height: view.getUint32(20),
    orientation: readPngOrientation(bytes, view),
  };
}

/** A PNG keeps EXIF in an `eXIf` chunk anywhere between IHDR and IEND; chunks
 *  are skipped by their declared length, never read. */
function readPngOrientation(bytes: Uint8Array, view: DataView): OrientationTag | undefined {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const dataLength = view.getUint32(offset);
    const start = offset + 4;
    if (startsWith(bytes, ascii("IEND"), start)) return undefined;
    if (startsWith(bytes, ascii("eXIf"), start)) {
      // A chunk cut short has no checksum to rewrite, and no decoder reads it.
      if (start + 4 + dataLength + 4 > bytes.length) return undefined;
      const tag = readOrientation(view, start + 4, start + 4 + dataLength);
      return tag === undefined ? undefined : { ...tag, chunk: { start, dataLength } };
    }
    offset += 12 + dataLength;
  }
  return undefined;
}

// Every start-of-frame marker carries the size; DHT (C4), JPG (C8) and DAC (CC)
// share the range and do not.
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_APP1 = 0xe1;
const JPEG_START_OF_SCAN = 0xda;
const JPEG_END_OF_IMAGE = 0xd9;

/** Walks the segments up to the image data: the first frame gives the size,
 *  the first EXIF block the orientation, wherever each sits among them. */
function readJpeg(bytes: Uint8Array, view: DataView): ImageHeader {
  let size: { width: number; height: number } | undefined;
  let orientation: OrientationTag | undefined;
  let exifSeen = false;
  let offset = 2;
  for (;;) {
    need(bytes, offset + 2, "JPEG");
    if (bytes[offset] !== 0xff) {
      throw new ImageHeaderError(`The JPEG has no marker at byte ${offset}.`);
    }
    // Fill bytes before a marker.
    while (bytes[offset] === 0xff) offset++;
    need(bytes, offset + 1, "JPEG");
    const marker = bytes[offset]!;
    offset++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === JPEG_START_OF_SCAN) break;
    if (marker === JPEG_END_OF_IMAGE) {
      throw new ImageHeaderError("The JPEG ends before any image data.");
    }
    need(bytes, offset + 2, "JPEG");
    const length = view.getUint16(offset);
    if (length < 2) throw new ImageHeaderError(`The JPEG has a malformed segment at byte ${offset}.`);
    if (size === undefined && JPEG_FRAME_MARKERS.has(marker)) {
      need(bytes, offset + 7, "JPEG");
      size = { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    if (!exifSeen && marker === JPEG_APP1 && startsWith(bytes, EXIF_PREFIX, offset + 2)) {
      exifSeen = true;
      const end = Math.min(offset + length, bytes.length);
      orientation = readOrientation(view, offset + 2 + EXIF_PREFIX.length, end);
    }
    offset += length;
  }
  if (size === undefined) {
    throw new ImageHeaderError("The JPEG reaches its image data before declaring a frame size.");
  }
  return { format: "jpeg", ...size, orientation };
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
    return {
      format: "webp",
      width: uint24(bytes, 24) + 1,
      height: uint24(bytes, 27) + 1,
      orientation: readWebpOrientation(bytes, view),
    };
  }
  throw new ImageHeaderError(`The WebP starts with an unknown '${chunk}' chunk.`);
}

/** The extended format keeps EXIF in a chunk of its own, anywhere after the
 *  header; chunks are skipped by their declared size, never read. */
function readWebpOrientation(bytes: Uint8Array, view: DataView): OrientationTag | undefined {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (startsWith(bytes, ascii("EXIF"), offset)) {
      const end = Math.min(start + size, bytes.length);
      // Some writers keep the JPEG prefix in front of the TIFF block.
      const tiff = startsWith(bytes, EXIF_PREFIX, start) ? start + EXIF_PREFIX.length : start;
      return readOrientation(view, tiff, end);
    }
    offset = start + size + (size % 2);
  }
  return undefined;
}

function readGif(bytes: Uint8Array, view: DataView): ImageHeader {
  need(bytes, 13, "GIF");
  let width = view.getUint16(6, true);
  let height = view.getUint16(8, true);
  let offset = 13 + colorTableLength(bytes[10]!);
  // Up to the first frame, which a decoder may let reach past the declared screen.
  while (offset < bytes.length) {
    const block = bytes[offset]!;
    if (block === 0x2c) {
      need(bytes, offset + 10, "GIF");
      width = Math.max(width, view.getUint16(offset + 1, true) + view.getUint16(offset + 5, true));
      height = Math.max(height, view.getUint16(offset + 3, true) + view.getUint16(offset + 7, true));
      requireFrameData(bytes, offset + 10 + colorTableLength(bytes[offset + 9]!));
      return { format: "gif", width, height };
    }
    if (block !== 0x21) break;
    offset += 2;
    while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset]!;
    offset++;
  }
  throw new ImageHeaderError("The GIF holds no frame.");
}

/** The first frame's data must run to its terminator: a decoder draws a frame
 *  cut short as far as it got, which is not the image. Blocks are stepped over
 *  by their length, never read. */
function requireFrameData(bytes: Uint8Array, start: number): void {
  // One byte of code size, then length-prefixed blocks up to an empty one.
  let offset = start + 1;
  while (offset < bytes.length) {
    if (bytes[offset] === 0) return;
    offset += 1 + bytes[offset]!;
  }
  throw new ImageHeaderError("The GIF's first frame is cut short.");
}

function colorTableLength(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const ORIENTATION = 0x0112;
const TIFF_SHORT = 3;

/** The orientation entry of a TIFF block's first directory, when it holds one
 *  of the seven values that are not upright. A block that does not read is no
 *  orientation, which is how a decoder takes it. */
function readOrientation(view: DataView, tiff: number, end: number): OrientationTag | undefined {
  if (tiff + 8 > end) return undefined;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const littleEndian = order === 0x4949;
  if (view.getUint16(tiff + 2, littleEndian) !== 42) return undefined;
  const directory = tiff + view.getUint32(tiff + 4, littleEndian);
  if (directory + 2 > end) return undefined;
  const entries = view.getUint16(directory, littleEndian);
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) return undefined;
    if (view.getUint16(entry, littleEndian) !== ORIENTATION) continue;
    if (view.getUint16(entry + 2, littleEndian) !== TIFF_SHORT) return undefined;
    const value = view.getUint16(entry + 8, littleEndian);
    return value >= 2 && value <= 8 ? { value, offset: entry + 8, littleEndian } : undefined;
  }
  return undefined;
}

function need(bytes: Uint8Array, length: number, format: string): void {
  if (bytes.length < length) {
    throw new ImageHeaderError(`The ${format} header is truncated (${bytes.length} bytes).`);
  }
}

function describeUnknown(bytes: Uint8Array): string {
  if (bytes.length === 0) return "The image is empty";
  if (startsWith(bytes, ascii("%PDF"))) {
    return "The bytes are a PDF, which is not an image — render its pages to images first";
  }
  if (startsWith(bytes, ascii("ftyp"), 4)) return "The image is an ISO media file (AVIF or HEIF)";
  if (startsWith(bytes, ascii("BM"))) return "The image is a BMP";
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

const CRC_TABLE = Uint32Array.from({ length: 256 }, (unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 a PNG chunk carries over its type and data. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
