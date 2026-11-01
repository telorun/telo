import { describe, expect, it } from "vitest";
import { BundlePreparations } from "../src/controller-loaders/bundle-preparations.js";

describe("a load's bundle preparations", () => {
  it("prepares a key once for every kind asking, until the load clears them", async () => {
    const preparations = new BundlePreparations();
    let runs = 0;
    const prepare = async () => ++runs;

    expect(await Promise.all([preparations.once("build", prepare), preparations.once("build", prepare)])).toEqual([1, 1]);
    expect(await preparations.once("build", prepare)).toBe(1);

    preparations.clear();
    expect(await preparations.once("build", prepare)).toBe(2);
  });

  it("prepares again after a failed preparation", async () => {
    const preparations = new BundlePreparations();
    await expect(preparations.once("build", () => Promise.reject(new Error("no esbuild")))).rejects.toThrow("no esbuild");
    expect(await preparations.once("build", async () => "built")).toBe("built");
  });
});
