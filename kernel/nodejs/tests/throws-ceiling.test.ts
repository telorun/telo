import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { refuseThrowsOutsideCeiling } from "../src/controllers/resource-definition/throws-ceiling-guard.js";
import { createKindDocument } from "./create-kind-document.js";

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

/** What the kernel refuses where it creates a `Telo.Definition` /
 *  `Telo.Abstract`: the document against its built-in entry's schema. */
const refusedBySchema = (message: RegExp) => ({
  code: "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
  message: expect.stringMatching(message),
});

describe("throws: on a Telo.Abstract", () => {
  it("accepts a literal list on a dispatchable capability", async () => {
    expect(await createKindDocument(lookup)).toBeUndefined();
  });

  it("refuses inherit, which has no body to come from", async () => {
    expect(await createKindDocument({ ...lookup, throws: { inherit: true } })).toMatchObject(
      refusedBySchema(/'inherit' is not allowed/),
    );
  });

  it("refuses a list on a capability with no caller to catch it", async () => {
    expect(await createKindDocument({ ...lookup, capability: "Telo.Service" })).toMatchObject(
      refusedBySchema(/\/throws is not allowed here/),
    );
  });

  it("refuses inherit even set to false, and a malformed code", async () => {
    expect(await createKindDocument({ ...lookup, throws: { inherit: false } })).toMatchObject(
      refusedBySchema(/'inherit' is not allowed/),
    );
    expect(
      await createKindDocument({ ...lookup, throws: { codes: { lowercase_code: {} } } }),
    ).toMatchObject(refusedBySchema(/lowercase_code/));
  });
});

describe("throws: on a Telo.Definition", () => {
  const definition = (fields: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Store" },
    controllers: ["pkg:npm/store@1.0.0"],
    throws: { codes: codes("ERR_NOT_FOUND") },
    ...fields,
  });

  it("refuses a list on a capability with no caller to catch it, as telo check does", async () => {
    expect(await createKindDocument(definition({ capability: "Telo.Mount" }))).toMatchObject(
      refusedBySchema(/\/throws is not allowed here/),
    );
  });

  it("admits a list where the capability is inherited through extends", async () => {
    const declared = `kind: Telo.Abstract
metadata:
  name: Lookup
capability: Telo.Invocable
throws:
  codes:
    ERR_NOT_FOUND: { description: ERR_NOT_FOUND }
`;
    expect(await createKindDocument(definition({ extends: "Lib.Lookup" }), declared)).toBeUndefined();
  });
});
