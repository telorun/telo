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
    schema: Type.Optional(Type.Object({}, { additionalProperties: true })),
    inputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
    outputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
    contexts: Type.Optional(
      Type.Array(
        Type.Object({
          scope: Type.String(),
          schema: Type.Object({}, { additionalProperties: true }),
        }),
      ),
    ),
    capability: Type.Optional(Type.String()),
    expand: Type.Optional(
      Type.Object({
        compile: Type.Optional(Type.Array(Type.String())),
        runtime: Type.Optional(Type.Array(Type.String())),
      }),
    ),
    events: Type.Optional(Type.Array(Type.String())),
    controllers: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

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
