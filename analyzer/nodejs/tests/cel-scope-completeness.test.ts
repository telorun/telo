import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * What a CEL expression may NAME, and what it must evaluate TO.
 *
 * cel-js types an unknown identifier as `dyn` and accepts it, so a bare typo
 * reached the runtime with no static report at all — while a typo one level in
 * (`ports.nope`) was an error, because member access on a TYPED root is
 * checked. `variables` was the root that was never typed for an ordinary
 * resource: only a module-identity doc carries the block, so every resource got
 * an open map, which also left the expression's own type unknown and the
 * "returns X but the field expects Y" check unable to fire.
 */

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "App" },
  variables: { env: { env: "APP_ENV", type: "string", default: "dev" } },
  secrets: { token: { env: "TOKEN", type: "string" } },
} as unknown as ResourceManifest;

const KIND: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Thing", module: "Test" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", "x-telo-eval": "compile" },
      label: { type: "string", "x-telo-eval": "compile" },
    },
  },
} as unknown as ResourceManifest;

function diagnosticsFor(fields: Record<string, unknown>, docs: ResourceManifest[] = []) {
  const resource = {
    kind: "Test.Thing",
    metadata: { name: "r" },
    ...fields,
  } as unknown as ResourceManifest;
  return new StaticAnalyzer().analyze(withSyntheticPositions([APP, KIND, ...docs, resource]));
}

/** CEL codes only — an unused `variables` entry is a finding about the
 *  declaration, not about the expression under test. */
function codesFor(fields: Record<string, unknown>): string[] {
  return diagnosticsFor(fields)
    .map((d) => d.code)
    .filter((code) => code.startsWith("CEL_"));
}

describe("an undeclared root identifier", () => {
  it("is reported", () => {
    const codes = codesFor({ enabled: makeTaggedSentinel("cel", "fff") });
    expect(codes).toContain("CEL_UNKNOWN_IDENTIFIER");
  });

  it("names the root that is missing", () => {
    const [d] = diagnosticsFor({ enabled: makeTaggedSentinel("cel", "fff && true") }).filter(
      (x) => x.code === "CEL_UNKNOWN_IDENTIFIER",
    );
    expect(d?.message).toContain("'fff'");
  });

  it("is not reported for a kernel global, nor for a CEL type name", () => {
    expect(codesFor({ label: makeTaggedSentinel("cel", "variables.env") })).not.toContain(
      "CEL_UNKNOWN_IDENTIFIER",
    );
    expect(codesFor({ label: makeTaggedSentinel("cel", "string(1)") })).not.toContain(
      "CEL_UNKNOWN_IDENTIFIER",
    );
  });

  it("is not reported for a name a comprehension binds", () => {
    // `extractAccessChains` drops what `.all(x, …)` binds, so the check never
    // sees `x` as a root.
    expect(
      codesFor({ enabled: makeTaggedSentinel("cel", "[1, 2].all(x, x > 0)") }),
    ).not.toContain("CEL_UNKNOWN_IDENTIFIER");
  });
});

describe("variables and secrets, typed per declaring module", () => {
  it("reports an unknown member of a declared block", () => {
    expect(codesFor({ label: makeTaggedSentinel("cel", "variables.nope") })).toContain(
      "CEL_TYPE_ERROR",
    );
    expect(codesFor({ label: makeTaggedSentinel("cel", "secrets.nope") })).toContain(
      "CEL_TYPE_ERROR",
    );
  });

  it("accepts a declared one", () => {
    expect(codesFor({ label: makeTaggedSentinel("cel", "variables.env") })).toEqual([]);
    expect(codesFor({ label: makeTaggedSentinel("cel", "secrets.token") })).toEqual([]);
  });

  it("types a resource forwarded from an imported library from ITS module", () => {
    // `metadata.moduleGlobals` is the declaring library's block, carried across
    // the flattened boundary — it must win over the consuming application's.
    const forwarded = {
      kind: "Test.Thing",
      metadata: {
        name: "lib",
        module: "Lib",
        moduleGlobals: { variables: { libOnly: { type: "string" } } },
      },
      label: makeTaggedSentinel("cel", "variables.libOnly"),
    } as unknown as ResourceManifest;
    const codes = new StaticAnalyzer()
      .analyze(withSyntheticPositions([APP, KIND, forwarded]))
      .map((d) => d.code);
    expect(codes).not.toContain("CEL_TYPE_ERROR");
    expect(codes).not.toContain("CEL_UNKNOWN_IDENTIFIER");
  });
});

describe("where the CEL belongs to another scope", () => {
  it("stands down inside a kind document", () => {
    // A definition's `examples:` show a CONSUMER's manifest — `request`,
    // `result`, `${{ secrets.API_KEY }}`. None of those are in scope where they
    // are written, and all of them are correct where they are read.
    const kindWithExample = {
      kind: "Telo.Definition",
      metadata: { name: "Sample", module: "Test" },
      capability: "Telo.Service",
      schema: {
        type: "object",
        properties: { field: { type: "string", "x-telo-eval": "compile" } },
        examples: [{ field: makeTaggedSentinel("cel", "request.query.q") }],
      },
    } as unknown as ResourceManifest;
    const codes = new StaticAnalyzer()
      .analyze(withSyntheticPositions([APP, kindWithExample]))
      .map((d) => d.code);
    expect(codes).not.toContain("CEL_UNKNOWN_IDENTIFIER");
  });

  it("stands down below a nested inline resource", () => {
    // That CEL is the nested kind's, and is analyzed again in its own scope as
    // the resource it was extracted into — the boundary the non-eval-field
    // check already draws.
    const host = {
      kind: "Test.Thing",
      metadata: { name: "host" },
      enabled: true,
      nested: { kind: "Test.Thing", label: makeTaggedSentinel("cel", "item.name") },
    } as unknown as ResourceManifest;
    const codes = new StaticAnalyzer()
      .analyze(withSyntheticPositions([APP, KIND, host]))
      .map((d) => d.code);
    expect(codes).not.toContain("CEL_UNKNOWN_IDENTIFIER");
  });
});

describe("the expression's type against the field's", () => {
  it("reports a string where the field declares a boolean", () => {
    const [d] = diagnosticsFor({ enabled: makeTaggedSentinel("cel", "variables.env") }).filter(
      (x) => x.code === "CEL_TYPE_ERROR",
    );
    expect(d?.message).toContain("expects 'boolean'");
  });

  it("accepts an expression of the declared type", () => {
    expect(codesFor({ enabled: makeTaggedSentinel("cel", "variables.env == 'dev'") })).toEqual(
      [],
    );
  });
});
