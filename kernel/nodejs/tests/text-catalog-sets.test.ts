import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A kind's catalog set is refused when the kernel registers the definition — the
 * twin of `telo check`'s refusal at the kind, which a consumer's analysis reports
 * at the import before the kernel ever registers it.
 */
describe("a misplaced catalog set", () => {
  const register = (schema: Record<string, unknown>) => () =>
    new Kernel({ sources: [new LocalFileSource()], env: {} }).registerResourceDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Lookup", module: "Fixture" },
      capability: "Telo.Provider",
      schema,
    } as any);

  it("is refused when it marks a field holding no catalog and no reference", () => {
    expect(register({ type: "object", properties: { label: { type: "string", "x-telo-text-catalog-set": true } } })).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_CATALOG_SET_INVALID",
        message: expect.stringContaining(
          "Telo.Definition 'Lookup' marks 'schema.properties.label.x-telo-text-catalog-set' as a catalog set, and nothing at or beneath it",
        ),
      }),
    );
  });

  it("is refused when its mark is not true", () => {
    expect(register({ type: "object", "x-telo-text-catalog-set": "yes", properties: {} })).toThrow(
      expect.objectContaining({ code: "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED" }),
    );
  });
});
