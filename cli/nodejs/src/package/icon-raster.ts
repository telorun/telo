import { PNG } from "pngjs";

/**
 * The application icon as pixels: decoded once from the author's PNG, reduced to
 * each size an icon format holds, and encoded back. RGBA, 8 bits a channel.
 */

export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

const COLOR_TYPE_RGBA = 6;

export function decodePng(bytes: Buffer): Raster {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(raster: Raster): Buffer {
  const png = new PNG({ width: raster.width, height: raster.height });
  raster.data.copy(png.data);
  return PNG.sync.write(png, { colorType: COLOR_TYPE_RGBA });
}

/** For each target index, the source indices it covers and how much of each. */
function coverage(from: number, to: number): Array<Array<[number, number]>> {
  const scale = from / to;
  const spans: Array<Array<[number, number]>> = [];
  for (let i = 0; i < to; i++) {
    const start = i * scale;
    const end = start + scale;
    const span: Array<[number, number]> = [];
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
      const weight = Math.min(end, s + 1) - Math.max(start, s);
      if (weight > 0) span.push([s, weight / scale]);
    }
    spans.push(span);
  }
  return spans;
}

/**
 * `raster` reduced to `size` × `size` by area averaging: each target pixel is
 * the mean of the source area it covers, weighted by alpha so a transparent
 * pixel's colour does not bleed into its neighbours. `raster` is square and at
 * least `size` on a side.
 */
export function downscale(raster: Raster, size: number): Raster {
  if (raster.width === size && raster.height === size) return raster;
  const { width, height, data } = raster;
  const columns = coverage(width, size);
  const rows = coverage(height, size);
  // Horizontal pass into premultiplied floats, then the vertical pass.
  const across = new Float64Array(size * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of columns[x]!) {
        const at = (y * width + s) * 4;
        const alpha = data[at + 3]! * w;
        r += data[at]! * alpha;
        g += data[at + 1]! * alpha;
        b += data[at + 2]! * alpha;
        a += alpha;
      }
      const out = (y * size + x) * 4;
      across[out] = r;
      across[out + 1] = g;
      across[out + 2] = b;
      across[out + 3] = a;
    }
  }
  const result = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of rows[y]!) {
        const at = (s * size + x) * 4;
        r += across[at]! * w;
        g += across[at + 1]! * w;
        b += across[at + 2]! * w;
        a += across[at + 3]! * w;
      }
      const out = (y * size + x) * 4;
      if (a > 0) {
        result[out] = Math.round(r / a);
        result[out + 1] = Math.round(g / a);
        result[out + 2] = Math.round(b / a);
      }
      result[out + 3] = Math.round(a);
    }
  }
  return { width: size, height: size, data: result };
}
