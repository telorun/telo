import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
const Ajv = AjvModule.default ?? AjvModule;

export const RuntimeResourceSchema = Type.Object(
  {
    kind: Type.String(),
    metadata: Type.Object({ name: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

const metadataSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    module: { type: "string" },
  },
  additionalProperties: true,
};

const baseDefinition = {
  type: "object",
  required: ["kind", "metadata"],
  properties: {
    kind: { const: "Telo.Definition" },
    metadata: metadataSchema,
    capability: { type: "string" },
    schema: { type: "object", additionalProperties: true },
    controllers: { type: "array", items: { type: "string" } },
  },
  unevaluatedProperties: false,
};

const KNOWN_CAPABILITIES = [
  "Telo.Service",
  "Telo.Runnable",
  "Telo.Invocable",
  "Telo.Provider",
  "Telo.Type",
  "Telo.Mount",
] as const;

export const ResourceDefinitionSchema = {
  ...baseDefinition,
  oneOf: [
    { required: ["capability"], properties: { capability: { const: "Telo.Service" } } },
    { required: ["capability"], properties: { capability: { const: "Telo.Runnable" } } },
    { required: ["capability"], properties: { capability: { const: "Telo.Invocable" } } },
    { required: ["capability"], properties: { capability: { const: "Telo.Provider" } } },
    { required: ["capability"], properties: { capability: { const: "Telo.Type" } } },
    {
      required: ["capability"],
      properties: {
        capability: { const: "Telo.Mount" },
      },
    },
    // Unknown/absent capability: open schema for third-party extensibility
    {
      not: {
        required: ["capability"],
        properties: { capability: { enum: KNOWN_CAPABILITIES } },
      },
      unevaluatedProperties: true,
    },
  ],
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats.default(ajv);

export const validateRuntimeResource = ajv.compile(RuntimeResourceSchema);
export const validateResourceDefinition = ajv.compile(ResourceDefinitionSchema);

export function formatAjvErrors(errors: any[] | null | undefined): string {
  if (!errors || errors.length === 0) return "Unknown schema error";
  return errors
    .map((err) => {
      const p = err.instancePath || "/";
      return `${p} ${err.message ?? "is invalid"}`;
    })
    .join("; ");
}
