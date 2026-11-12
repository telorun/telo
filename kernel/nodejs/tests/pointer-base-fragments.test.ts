import { expandManifestFragments } from "@telorun/analyzer";
import type { ResourceContext, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/controllers/type/json-schema-controller.js";
import { SchemaValidator } from "../src/schema-validator.js";

/**
 * A JSON Pointer `$ref` whose target is itself a reference to a named shape
 * holding a hoisted fragment (`Text`, whose `Message` is localized to
 * `#/$defs/telo:Message`) compiles: the pointer's base carries the shape's
 * fragments, whether the pointer is the schema's own or one into a shape the
 * kernel registered.
 */
const CAPTION = (() => {
  const document = { kind: "Telo.JsonSchema", metadata: { name: "Caption" }, schema: { $ref: "telo://manifest#/$defs/Text" } };
  expandManifestFragments(document);
  return document.schema as Record<string, any>;
})();

function registry(): SchemaValidator {
  const validator = new SchemaValidator();
  validator.addSchema("telo:T/Caption", CAPTION);
  return validator;
}

describe("a pointer $ref based in a schema", () => {
  it("reads a shape holding a hoisted fragment", () => {
    expect(Object.keys(CAPTION.$defs ?? {})).toContain("telo:Message");
  });

  it("compiles a schema whose local pointer lands on a named shape holding a hoisted fragment", () => {
    const validate = registry().compile({
      type: "object",
      properties: { caption: { $ref: "#/$defs/Holder/properties/caption" } },
      $defs: { Holder: { type: "object", properties: { caption: { $ref: "telo:T/Caption" } } } },
    });
    expect(validate.isValid({ caption: "Hello {$who}" })).toBe(true);
    expect(validate.isValid({ caption: 5 })).toBe(false);
  });

  it("compiles a pointer into a named shape the kernel registered", async () => {
    const validator = registry();
    const ctx = {
      lookupSchema: (name: string) => validator.getSchema(name),
      registerSchema: (name: string, schema: object) => validator.addSchema(name, schema),
      registerTypeRules: () => {},
    } as unknown as ResourceContext;
    await create(
      {
        kind: "Telo.JsonSchema",
        metadata: { name: "Holder", module: "T" },
        schema: { type: "object", properties: { caption: { $ref: "telo:T/Caption" } } },
      } as unknown as ResourceManifest,
      ctx,
    );
    const validate = validator.compile({
      type: "object",
      properties: { caption: { $ref: "telo:T/Holder#/properties/caption" } },
    });
    expect(validate.isValid({ caption: "Hello" })).toBe(true);
    expect(validate.isValid({ caption: 5 })).toBe(false);
  });
});
