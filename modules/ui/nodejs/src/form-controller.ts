import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { presentationAt } from "./collection-presentation.js";
import { enteredFields, type GroupConfig } from "./entered-fields.js";
import { modelSchema } from "./model-schema.js";
import { stateSpec, type StateConfig } from "./state-record.js";

type FormResource = RuntimeResource & {
  model: unknown;
  presentation: unknown;
  fields?: unknown[] | null;
  groups?: GroupConfig[] | null;
  state?: StateConfig | null;
};

class Form implements ResourceInstance {
  constructor(
    private readonly resource: FormResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const owner = `Ui.Form '${this.resource.metadata.name}'`;
    const schema = modelSchema(this.resource.model, this.ctx, owner);
    const { basePath, relations } = presentationAt(this.resource.presentation, this.ctx, owner);
    const { fields, groups } = await enteredFields(schema, this.resource.fields, this.resource.groups, this.ctx, owner, "model", relations);
    const state = await stateSpec(this.resource.state, fields.map((field) => field.property), schema, this.ctx, owner, "state", "field");
    const node: SpecNode = { type: "form", schema, basePath, fields, groups, state };
    return { node, assets: [] };
  }
}

export async function create(resource: FormResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Form(resource, ctx);
}
