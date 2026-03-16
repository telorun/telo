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
    schema: Type.Object({}, { additionalProperties: true }),
    inputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
    outputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
    contexts: Type.Optional(Type.Array(Type.Object({
      scope: Type.String(),
      schema: Type.Object({}, { additionalProperties: true }),
    }))),
    capabilities: Type.Array(Type.String(), { minItems: 1 }),
    events: Type.Optional(Type.Array(Type.String())),
    controllers: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats.default(ajv);

export const validateRuntimeResource = ajv.compile(RuntimeResourceSchema);
export const validateResourceDefinition = ajv.compile(ResourceDefinitionSchema);

export { formatAjvErrors } from "@telorun/analyzer";
