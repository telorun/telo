import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { enteredFields, type GroupConfig, type GroupSpec } from "./entered-fields.js";
import type { FieldSpec } from "./field-answer.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";

/** What a call asks before it runs, as a renderer receives it. */
export interface PromptSpec {
  schema: JsonSchema;
  fields: FieldSpec[];
  groups: GroupSpec[];
}

export interface PromptInstance {
  provide(): Promise<PromptSpec>;
}

export function isPrompt(candidate: unknown): candidate is PromptInstance {
  return typeof (candidate as Partial<PromptInstance> | null)?.provide === "function";
}

type PromptResource = RuntimeResource & {
  model: unknown;
  fields?: unknown[] | null;
  groups?: GroupConfig[] | null;
};

export async function create(resource: PromptResource, ctx: ResourceContext): Promise<ResourceInstance & PromptInstance> {
  const owner = `Ui.Prompt '${resource.metadata.name}'`;
  return {
    async provide() {
      const schema = modelSchema(resource.model, ctx, owner);
      const { fields, groups } = await enteredFields(schema, resource.fields, resource.groups, ctx, owner, "model");
      return { schema, fields, groups };
    },
  };
}
