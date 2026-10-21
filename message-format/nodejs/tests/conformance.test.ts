import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import { loadVectors } from "../conformance/load-vectors.js";
import { runVectors } from "../conformance/vector-runner.js";

/** Rows per set. A runner sees a row that disagrees and cannot see one that is gone,
 *  so the counts are pinned; `message-format/rust/tests/conformance.rs` pins the same. */
const COUNTS = {
  patterns: 46,
  messages: 38,
  numbers: 81,
  format: 44,
  categories: 15,
  categoryProblems: 8,
  unknownVariables: 9,
  chains: 7,
  lookups: 12,
  workingGroup: 247,
  cldrSamples: 12396,
};

describe("the conformance vectors", () => {
  it("answer as recorded under the Node core", () => {
    const report = runVectors(core, loadVectors());
    expect(report.failures).toEqual([]);
    expect(report.counts).toEqual(COUNTS);
  });
});
