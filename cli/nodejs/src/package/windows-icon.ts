import { decodePng, downscale, encodePng, type Raster } from "./icon-raster.js";

/**
 * A Windows application icon as the two resource kinds Explorer reads: one
 * `RT_ICON` per size and the `RT_GROUP_ICON` directory naming them. The 256 px
 * image is PNG-compressed, as an `.ico` may hold it; the smaller ones are 32-bit
 * bitmaps, the form every Windows API reads.
 */

export const ICON_SIZES = [256, 64, 48, 32, 24, 16] as const;

export interface WindowsIcon {
  /** Each image, in {@link ICON_SIZES} order; image `i` is filed as `RT_ICON` id `i + 1`. */
  readonly images: readonly Buffer[];
  /** The `GRPICONDIR` naming them. */
  readonly group: Buffer;
}

const BITMAPINFOHEADER_SIZE = 40;
const GROUP_HEADER_SIZE = 6;
const GROUP_ENTRY_SIZE = 14;

/** A 32-bit bottom-up bitmap with its AND mask, as an icon image holds one. */
function iconBitmap(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const maskStride = Math.ceil(width / 32) * 4;
  const pixels = width * height * 4;
  const bitmap = Buffer.alloc(BITMAPINFOHEADER_SIZE + pixels + maskStride * height);
  bitmap.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
  bitmap.writeInt32LE(width, 4);
  bitmap.writeInt32LE(height * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(pixels + maskStride * height, 20);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = BITMAPINFOHEADER_SIZE + (row * width + x) * 4;
      bitmap[to] = data[from + 2]!;
      bitmap[to + 1] = data[from + 1]!;
      bitmap[to + 2] = data[from]!;
      bitmap[to + 3] = data[from + 3]!;
      if (data[from + 3] === 0) {
        const mask = BITMAPINFOHEADER_SIZE + pixels + row * maskStride + (x >> 3);
        bitmap[mask] = bitmap[mask]! | (0x80 >> (x & 7));
      }
    }
  }
  return bitmap;
}

export function buildWindowsIcon(icon: Buffer): WindowsIcon {
  const source = decodePng(icon);
  const images = ICON_SIZES.map((size) => {
    const raster = downscale(source, size);
    return size === 256 ? encodePng(raster) : iconBitmap(raster);
  });
  const group = Buffer.alloc(GROUP_HEADER_SIZE + GROUP_ENTRY_SIZE * images.length);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(images.length, 4);
  images.forEach((image, i) => {
    const at = GROUP_HEADER_SIZE + i * GROUP_ENTRY_SIZE;
    const size = ICON_SIZES[i]!;
    group.writeUInt8(size >= 256 ? 0 : size, at);
    group.writeUInt8(size >= 256 ? 0 : size, at + 1);
    group.writeUInt16LE(1, at + 4);
    group.writeUInt16LE(32, at + 6);
    group.writeUInt32LE(image.length, at + 8);
    group.writeUInt16LE(i + 1, at + 12);
  });
  return { images, group };
}
