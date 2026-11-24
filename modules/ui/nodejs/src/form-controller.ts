import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { presentationAt } from "./collection-presentation.js";
import { enteredFields, type GroupConfig } from "./entered-fields.js";
import { modelSchema } from "./model-schema.js";
import type { Binding } from "./row-binding.js";
import { stateSpec, type StateConfig } from "./state-record.js";
import { filledProvided } from "./fill-marking.js";
import { assertWriteShape } from "./write-shape.js";

type FormResource = RuntimeResource & {
  model: unknown;
  record: { presentation: unknown; key?: Binding | null };
  initialValues?: Binding | null;
  unsaved?: string | null;
  afterSubmit?: string | null;
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
    const { record } = this.resource;
    const schema = modelSchema(this.resource.model, this.ctx, owner);
    const { basePath, collection, relations } = await presentationAt(record.presentation, this.ctx, owner);
    const key = record.key ?? null;
    assertWriteShape(schema, collection, key !== null, owner);
    const { fields, groups } = await enteredFields(schema, this.resource.fields, this.resource.groups, this.ctx, owner, "model", relations);
    const state = await stateSpec(this.resource.state, fields.map((field) => field.property), schema, this.ctx, owner, "state", "field");
    const node: SpecNode = {
      type: "form",
      schema,
      record: { basePath, key },
      initialValues: this.resource.initialValues ?? null,
      unsaved: this.resource.unsaved ?? "confirm",
      afterSubmit: this.resource.afterSubmit ?? "close",
      fields,
      groups,
      state,
    };
    return filledProvided({ node, assets: [] });
  }
}

export async function create(resource: FormResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Form(resource, ctx);
}
