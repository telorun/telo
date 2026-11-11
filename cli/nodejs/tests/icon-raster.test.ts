import { describe, expect, it } from "vitest";

import { downscale } from "../src/package/icon-raster.js";

describe("downscaling an icon", () => {
  it("averages the area each pixel covers, weighting colour by alpha so a transparent pixel's colour does not bleed", () => {
    // One opaque blue pixel among three transparent red ones.
    const data = Buffer.from([0, 0, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
    expect([...downscale({ width: 2, height: 2, data }, 1).data]).toEqual([0, 0, 255, 64]);
  });

  it("covers fractional source pixels when the sizes do not divide", () => {
    const data = Buffer.alloc(3 * 3 * 4);
    for (let i = 0; i < 9; i++) data.set([i < 3 ? 0 : 240, 0, 0, 255], i * 4);
    // Rows 0, 1, 2 at 0, 240, 240: the top output row covers row 0 and half of row 1.
    expect([...downscale({ width: 3, height: 3, data }, 2).data.subarray(0, 4)]).toEqual([80, 0, 0, 255]);
  });
});
