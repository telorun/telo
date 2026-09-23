import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { refuseThrowsOutsideCeiling } from "../src/controllers/resource-definition/throws-ceiling-guard.js";
import { validateResourceAbstract, validateResourceDefinition } from "../src/manifest-schemas.js";

const codes = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { description: n }]));

const lookup = {
  kind: "Telo.Abstract",
  metadata: { name: "Lookup", module: "Lib" },
  capability: "Telo.Invocable",
  throws: { codes: codes("ERR_NOT_FOUND") },
} as unknown as ResourceDefinition;

const resolveDef = (kind: string) => (kind === "Self.Lookup" ? lookup : undefined);

const child = (throws: unknown) =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Store", module: "Lib" },
    extends: "Self.Lookup",
    throws,
  }) as unknown as ResourceDefinition;

/** The registration half of `THROWS_NOT_SUBSTITUTABLE`; the pair is pinned by
 *  `tests/check-run-agreement.yaml`. This half is what refuses a dependency's
 *  kind on a load whose analysis did not reach it. */
describe("an ancestor's throws: is a ceiling", () => {
  it("refuses a code the ancestor does not declare", () => {
    expect(() =>
      refuseThrowsOutsideCeiling(child({ codes: codes("ERR_NOT_FOUND", "ERR_DOWN") }), resolveDef),
    ).toThrow(/ERR_DOWN.*'Lib\.Lookup' does not declare/);
  });

  it("admits a subset", () => {
    expect(() => refuseThrowsOutsideCeiling(child({ codes: codes("ERR_NOT_FOUND") }), resolveDef)).not.toThrow();
  });

  it("leaves a dynamic union to the per-dispatch check", () => {
    expect(() => refuseThrowsOutsideCeiling(child({ inherit: true }), resolveDef)).not.toThrow();
  });
});

describe("throws: on a Telo.Abstract", () => {
  it("accepts a literal list on a dispatchable capability", () => {
    expect(validateResourceAbstract(lookup)).toBe(true);
  });

  it("refuses inherit, which has no body to come from", () => {
    expect(validateResourceAbstract({ ...lookup, throws: { inherit: true } })).toBe(false);
  });

  it("refuses a list on a capability with no caller to catch it, a third party's included", () => {
    for (const capability of ["Telo.Service", "Acme.Custom"]) {
      expect(validateResourceAbstract({ ...lookup, capability })).toBe(false);
    }
  });

  it("refuses inherit even set to false, and a malformed code", () => {
    expect(validateResourceAbstract({ ...lookup, throws: { inherit: false } })).toBe(false);
    expect(validateResourceAbstract({ ...lookup, throws: { codes: { lowercase_code: {} } } })).toBe(false);
  });
});

describe("throws: on a Telo.Definition", () => {
  const definition = (fields: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Store" },
    controllers: ["pkg:npm/store@1.0.0"],
    throws: { codes: codes("ERR_DOWN") },
    ...fields,
  });

  it("refuses a list on a third party's capability, as telo check does", () => {
    expect(validateResourceDefinition(definition({ capability: "Acme.Custom" }))).toBe(false);
  });

  it("admits a list where the capability is inherited through extends", () => {
    expect(validateResourceDefinition(definition({ extends: "Lib.Lookup" }))).toBe(true);
  });
});
