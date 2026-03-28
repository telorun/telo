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
    kind: { const: "Kernel.Definition" },
    metadata: metadataSchema,
    capability: { type: "string" },
    schema: { type: "object", additionalProperties: true },
    controllers: { type: "array", items: { type: "string" } },
    expand: {
      type: "object",
      properties: {
        compile: { type: "array", items: { type: "string" } },
        runtime: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  unevaluatedProperties: false,
};

const KNOWN_CAPABILITIES = [
  "Kernel.Service",
  "Kernel.Runnable",
  "Kernel.Invocable",
  "Kernel.Provider",
  "Kernel.Type",
  "Kernel.Mount",
] as const;

export const ResourceDefinitionSchema = {
  ...baseDefinition,
  oneOf: [
    { required: ["capability"], properties: { capability: { const: "Kernel.Service" } } },
    { required: ["capability"], properties: { capability: { const: "Kernel.Runnable" } } },
    { required: ["capability"], properties: { capability: { const: "Kernel.Invocable" } } },
    { required: ["capability"], properties: { capability: { const: "Kernel.Provider" } } },
    { required: ["capability"], properties: { capability: { const: "Kernel.Type" } } },
    {
      required: ["capability"],
      properties: {
        capability: { const: "Kernel.Mount" },
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
