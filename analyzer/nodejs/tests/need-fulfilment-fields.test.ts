import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A fulfilment's author schema is closed, and an undeclared or missing field is
 * reported once — by the need table — never a second time as the schema's own
 * `additionalProperties` / `required` finding.
 */

const app = { kind: "Telo.Application", metadata: { name: "App" } };
const needType = {
  kind: "Telo.NeedType",
  metadata: { name: "DatabaseAccess", module: "App" },
  fields: { url: { type: "string" }, schema: { type: "string" } },
  required: ["url"],
};

function report(fields: Record<string, unknown>) {
  const fulfilment = { kind: "Self.DatabaseAccess", metadata: { name: "mainDatabase", module: "App" }, fields };
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, needType, fulfilment] as unknown as ResourceManifest[]))
    .map((d) => ({ code: d.code, path: (d.data as { path?: string } | undefined)?.path }));
}

describe("a fulfilment's fields", () => {
  it("reports an undeclared field once", () => {
    expect(report({ url: "postgres://localhost/main", host: "localhost" })).toEqual([
      { code: "NEED_FIELD_UNDECLARED", path: "fields.host" },
    ]);
  });

  it("reports a missing required field once", () => {
    expect(report({ schema: "main" })).toEqual([{ code: "NEED_SLOT_MISMATCH", path: "fields" }]);
  });
});
