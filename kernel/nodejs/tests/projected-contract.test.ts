import { manifestListScope } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import type { ContractValidatorFactory } from "../src/invocation-contract-binding.js";
import { resolveBoundContract } from "../src/invocation-contract-binding.js";
import { SchemaValidator } from "../src/schema-validator.js";

const field = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["text"], "x-telo-schema-map": { text: { type: "string" } } },
    many: { type: "boolean", default: false },
    nullable: { type: "boolean", default: false },
    fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } },
  },
};

const definition = {
  kind: "Telo.Definition",
  metadata: { name: "Extract", module: "extract" },
  capability: "Telo.Invocable",
  "x-telo-schema-projection": {
    entries: "/fields",
    key: "type",
    array: "many",
    nullable: "nullable",
    nested: "fields",
  },
  outputType: {
    type: "object",
    required: ["fields"],
    properties: { fields: { "x-telo-schema-projection-from": "" } },
  },
  schema: {
    type: "object",
    $defs: { Field: field },
    properties: { fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } } },
  },
};

const extraction = {
  kind: "extract.Extract",
  metadata: { name: "page", module: "app" },
  fields: { cards: { many: true, fields: { name: { type: "text" } } } },
};

function factory(): ContractValidatorFactory {
  const validator = new SchemaValidator();
  return Object.assign((schema: unknown) => validator.compile(schema), {
    schemaOf: (schema: unknown) => schema as Record<string, any>,
    resolveRef: () => undefined,
    withRules: (name: string | undefined, schema: Record<string, any>) => validator.compile(schema),
  }) as ContractValidatorFactory;
}

describe("a nested projection at dispatch", () => {
  it("enforces the nested shape the analyzer types", () => {
    const bound = resolveBoundContract(
      "outputType",
      extraction as any,
      definition as any,
      () => undefined,
      factory(),
      manifestListScope([extraction], () => definition),
    )!;
    expect(() => bound.validate({ fields: { cards: [{ name: "a" }] } })).not.toThrow();
    expect(() => bound.validate({ fields: { cards: [{ nmae: "a" }] } })).toThrow(
      "'nmae' is not allowed",
    );
  });
});
