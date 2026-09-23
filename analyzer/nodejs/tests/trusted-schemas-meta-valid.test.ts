import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { KERNEL_BUILTINS } from "../src/builtins.js";
import { ManifestRootSchema } from "../src/manifest-schemas.js";

// Registries add these without meta-validation, so their validity is asserted here.
describe("schemas registered as trusted", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });

  it("ManifestRootSchema is a valid JSON Schema", () => {
    expect(ajv.validateSchema(ManifestRootSchema), ajv.errorsText(ajv.errors)).toBe(true);
  });

  for (const def of KERNEL_BUILTINS) {
    if (!def.schema) continue;
    it(`built-in ${def.metadata.module}.${def.metadata.name} schema is a valid JSON Schema`, () => {
      expect(ajv.validateSchema(def.schema as object), ajv.errorsText(ajv.errors)).toBe(true);
    });
  }
});
