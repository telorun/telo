import { Type } from "@sinclair/typebox";
import AjvModule, { ErrorObject } from "ajv";
const Ajv = AjvModule.default ?? AjvModule;

export const RuntimeResourceSchema = Type.Object(
  {
    kind: Type.String(),
    metadata: Type.Object({ name: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

export const ResourceDefinitionSchema = Type.Object(
  {
    kind: Type.Literal("Kernel.Definition"),
    metadata: Type.Object(
      {
        name: Type.String(),
        module: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    schema: Type.Object({}, { additionalProperties: true }),
    capabilities: Type.Array(Type.String(), { minItems: 1 }),
    events: Type.Optional(Type.Array(Type.String())),
    controllers: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateRuntimeResource = ajv.compile(RuntimeResourceSchema);
export const validateResourceDefinition = ajv.compile(ResourceDefinitionSchema);

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "Unknown schema error";
  }
  return errors
    .map((err) => {
      const path = err.instancePath && err.instancePath.length > 0 ? err.instancePath : "/";
      const message = err.message || "is invalid";
      return `${path} ${message}`;
    })
    .join("; ");
}
