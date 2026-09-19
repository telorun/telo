import { describe, expect, it, vi } from "vitest";
import {
  readKernelVersion,
  readVersion,
  reportUndeterminableVersion,
} from "../src/runtime-versions.js";

/**
 * The rule these caches rest on: a version that cannot be determined is not a
 * version. Keyed on a placeholder every installation agrees on, one version's
 * cache entry is served to another — which is what the string `unknown` did.
 */
describe("runtime versions", () => {
  it("reads an installed dependency's version", () => {
    expect(readVersion("ajv")).toMatch(/^\d+\.\d+\.\d+/);
    expect(readKernelVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("answers undefined rather than a placeholder", () => {
    expect(readVersion("@telorun/not-a-real-package")).toBeUndefined();
  });

  it("reports an undeterminable version once per cache", () => {
    const report = vi.fn();
    reportUndeterminableVersion("a-cache-named-for-this-test", ["pkg-a", "pkg-b"], report);
    reportUndeterminableVersion("a-cache-named-for-this-test", ["pkg-a", "pkg-b"], report);
    expect(report).toHaveBeenCalledTimes(1);
    // The message has to say what stopped working, or a silent slowdown is all
    // the reader gets.
    expect(report.mock.calls[0]![0]).toContain("pkg-a / pkg-b");
    expect(report.mock.calls[0]![0]).toContain("neither read nor written");
  });
});
