import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseLayerIndex } from "../src/artifact-layer-index.js";
import {
  describeSelector,
  normalizeAxisValue,
  normalizeSelector,
  selectorKey,
  selectorMatches,
  type ArtifactSelector,
  type PlatformTarget,
} from "../src/artifact-selector.js";

// The same file `analyzer/rust/src/artifact_layer_index.rs` runs: a case that
// fails here and passes there (or the reverse) is two kernels reading one
// published index differently.
const VECTORS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../artifact-axes/layer-index-vectors.json"),
    "utf-8",
  ),
) as {
  axisValues: Array<{ axis: string; value: string; normalized?: string; error?: string }>;
  selectorKeys: Array<{ selector: unknown; key: string; description: string }>;
  matching: Array<{ name: string; selector: unknown; target: PlatformTarget; matches: boolean }>;
  layerIndexes: Array<{
    name: string;
    layers: unknown;
    expected?: unknown;
    error?: { code: string; message: string };
  }>;
};

function selector(raw: unknown): ArtifactSelector {
  const normalized = normalizeSelector(raw, "selector");
  if (!normalized) throw new Error(`vector selector ${JSON.stringify(raw)} carries an unknown axis`);
  return normalized;
}

function outcome(run: () => unknown): { value?: unknown; error?: { code: string; message: string } } {
  try {
    return { value: run() };
  } catch (err) {
    const { code, message } = err as { code: string; message: string };
    return { error: { code, message } };
  }
}

describe("shared layer-index vectors", () => {
  it("normalizes axis values", () => {
    for (const v of VECTORS.axisValues) {
      const got = outcome(() => normalizeAxisValue(v.axis, v.value, "selector"));
      if (v.error !== undefined) expect(got.error?.message, `${v.axis}=${v.value}`).toBe(v.error);
      else expect(got, `${v.axis}=${v.value}`).toEqual({ value: v.normalized });
    }
  });

  it("renders canonical keys and descriptions", () => {
    for (const v of VECTORS.selectorKeys) {
      expect(selectorKey(selector(v.selector))).toBe(v.key);
      expect(describeSelector(selector(v.selector))).toBe(v.description);
    }
  });

  it("matches selectors against targets", () => {
    for (const v of VECTORS.matching) {
      expect(selectorMatches(selector(v.selector), v.target), v.name).toBe(v.matches);
    }
  });

  it("parses layer indexes", () => {
    for (const v of VECTORS.layerIndexes) {
      const got = outcome(() => parseLayerIndex(v.layers));
      expect(got, v.name).toEqual(v.error ? { error: v.error } : { value: v.expected });
    }
  });
});
