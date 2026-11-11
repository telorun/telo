import { decodePng, downscale, encodePng } from "./icon-raster.js";

/**
 * A macOS icon file (`.icns`) from the application's PNG: one PNG-compressed
 * entry per size Finder and the Dock ask for, the 1024 px one (`ic10`) the
 * author's own bytes when the icon is exactly that size.
 */

/** Each entry type and the pixel size it holds; the `@2x` types repeat a size. */
export const ICNS_ENTRIES: ReadonlyArray<readonly [type: string, size: number]> = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

export function buildIcns(icon: Buffer): Buffer {
  const source = decodePng(icon);
  const encoded = new Map<number, Buffer>();
  const pngAt = (size: number): Buffer => {
    const known = encoded.get(size);
    if (known) return known;
    const bytes = source.width === size && source.height === size ? icon : encodePng(downscale(source, size));
    encoded.set(size, bytes);
    return bytes;
  };
  const chunks = ICNS_ENTRIES.map(([type, size]) => {
    const data = pngAt(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
