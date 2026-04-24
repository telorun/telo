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

const throwsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    codes: {
      type: "object",
      propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
      additionalProperties: {
        type: "object",
        required: ["description"],
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
      },
    },
    // "my throw union includes every code thrown by every invocable I call
    //  (minus codes caught in an enclosing try/catch)". Analyzer enforces
    //  that this is only legal on definitions whose schema declares at least
    //  one `x-telo-step-context` array.
    inherit: { type: "boolean" },
    // "my throw union is whatever `inputs.code` resolves to statically." Used
    // by passthrough-style adapters. Analyzer resolves per call site.
    passthrough: { type: "boolean" },
  },
};

/** Alias-form pattern for `extends` values: "<Alias>.<AbstractName>".
 *  Resolved against the declaring file's `Telo.Import` aliases — identical to how
 *  kind prefixes work (e.g. `kind: Http.Api` resolves `Http` via the importer's
 *  alias registration). Identity form (`std/mod#Name`) is intentionally not
 *  accepted: aliases carry the module version via their `Telo.Import` source,
 *  which canonical module names can't.
 *  - Alias: PascalCase (first letter uppercase)
 *  - Name: PascalCase */
const EXTENDS_ALIAS_PATTERN = "^[A-Z][A-Za-z0-9_]*\\.[A-Z][A-Za-z0-9_]*$";

const baseDefinition = {
  type: "object",
  required: ["kind", "metadata"],
  properties: {
    kind: { const: "Telo.Definition" },
    metadata: metadataSchema,
    capability: { type: "string" },
    extends: { type: "string", pattern: EXTENDS_ALIAS_PATTERN },
    schema: { type: "object", additionalProperties: true },
    controllers: { type: "array", items: { type: "string" } },
    throws: throwsSchema,
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

/** Rule 8: `throws:` is only meaningful on Telo.Invocable or Telo.Runnable.
 *  On Service/Mount/Provider/Type/etc. a thrown error is a boot-time failure,
 *  not a structured runtime error for a downstream caller, so declaring one
 *  is a schema error. */
const forbidThrows = { not: { required: ["throws"] } };

export const ResourceDefinitionSchema = {
  ...baseDefinition,
  oneOf: [
    {
      required: ["capability"],
      properties: { capability: { const: "Telo.Service" } },
      ...forbidThrows,
    },
    { required: ["capability"], properties: { capability: { const: "Telo.Runnable" } } },
    { required: ["capability"], properties: { capability: { const: "Telo.Invocable" } } },
    {
      required: ["capability"],
      properties: { capability: { const: "Telo.Provider" } },
      ...forbidThrows,
    },
    {
      required: ["capability"],
      properties: { capability: { const: "Telo.Type" } },
      ...forbidThrows,
    },
    {
      required: ["capability"],
      properties: { capability: { const: "Telo.Mount" } },
      ...forbidThrows,
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

/** Schema for `kind: Telo.Abstract`. Library-declared abstracts are type blueprints —
 *  they may carry an optional `capability` (lifecycle inherited by implementations)
 *  and an optional `schema` (shared base for implementations). `controllers` and `throws`
 *  are forbidden (no runtime implementation; throws lives on concrete definitions).
 *  Other fields are permitted for forward compatibility with typed-abstracts work
 *  (inputType, outputType, …) — Telo.Abstract is an extension point by design. */
export const ResourceAbstractSchema = {
  type: "object",
  required: ["kind", "metadata"],
  properties: {
    kind: { const: "Telo.Abstract" },
    metadata: metadataSchema,
    capability: { type: "string" },
    schema: { type: "object", additionalProperties: true },
  },
  not: {
    anyOf: [{ required: ["controllers"] }, { required: ["throws"] }],
  },
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats.default(ajv);

export const validateRuntimeResource = ajv.compile(RuntimeResourceSchema);
export const validateResourceDefinition = ajv.compile(ResourceDefinitionSchema);
export const validateResourceAbstract = ajv.compile(ResourceAbstractSchema);

export function formatAjvErrors(errors: any[] | null | undefined): string {
  if (!errors || errors.length === 0) return "Unknown schema error";
  return errors
    .map((err) => {
      const p = err.instancePath || "/";
      return `${p} ${err.message ?? "is invalid"}`;
    })
    .join("; ");
}
