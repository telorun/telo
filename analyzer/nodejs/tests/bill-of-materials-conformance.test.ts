import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalBillOfMaterialsText,
  componentRef,
  serializeModuleRecord,
  splitVcsQualifier,
  type RecordInput,
} from "../src/bill-of-materials.js";

/** The rows every writer of a bill of materials answers identically —
 *  `analyzer/bill-of-materials-conformance/README.md`. */
const vectors = JSON.parse(
  readFileSync(new URL("../../bill-of-materials-conformance/vectors.json", import.meta.url), "utf-8"),
) as {
  canonical: Array<{ id: string; document: unknown; expected: string }>;
  records: Array<{ id: string; input: RecordInput; expected: string }>;
};

describe("bill-of-materials conformance", () => {
  for (const row of vectors.canonical) {
    it(`writes ${row.id}`, () => {
      expect(canonicalBillOfMaterialsText(row.document)).toBe(row.expected);
    });
  }
  for (const row of vectors.records) {
    it(`records ${row.id}`, () => {
      expect(serializeModuleRecord(row.input)).toBe(row.expected);
    });
  }
  it("reads every vcs_url a record row writes back as the repository and commit", () => {
    const reports = vectors.records.flatMap((row) => row.input.components).filter((report) => report.vcs);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(splitVcsQualifier(componentRef(report.purl, report.version, report.vcs))).toEqual({
        purl: componentRef(report.purl, report.version),
        vcs: report.vcs,
      });
    }
  });
});
