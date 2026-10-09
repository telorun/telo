import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { enterableFields, isEnterable, labelOf, modelSchema, type JsonSchema } from "./model-schema.js";

type FormResource = RuntimeResource & {
  model: unknown;
  source: { basePath: string };
  fields?: { property: string }[];
};

/** The fields a form shows: the ones listed, or every property a control can enter. */
export function formFields(
  schema: JsonSchema,
  listed: { property: string }[] | undefined,
  owner: string,
): { property: string; label: string }[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  if (!listed) return enterableFields(schema);
  return listed.map(({ property }, index) => {
    if (!Object.hasOwn(properties, property)) {
      throw new RuntimeError(
        "ERR_UI_FORM_FIELD_UNKNOWN_PROPERTY",
        `${owner}: 'fields[${index}]' lists a field for a property the model does not declare ('${property}'). Use a property of 'model', or add this one to it.`,
      );
    }
    if (!isEnterable(properties[property])) {
      throw new RuntimeError(
        "ERR_UI_FORM_FIELD_UNSUPPORTED",
        `${owner}: 'fields[${index}]' lists a field for a property no control can enter ('${property}'). A field enters a string, a number, a boolean, one of an 'enum', or a list of those: remove this field, or give 'model' a property of such a type.`,
      );
    }
    return { property, label: labelOf(property, properties[property]) };
  });
}

class Form implements ResourceInstance {
  constructor(
    private readonly resource: FormResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const owner = `Ui.Form '${this.resource.metadata.name}'`;
    const schema = modelSchema(this.resource.model, this.ctx, owner);
    const node: SpecNode = {
      type: "form",
      schema,
      basePath: this.resource.source.basePath,
      fields: formFields(schema, this.resource.fields, owner),
    };
    return { node, assets: [] };
  }
}

export async function create(resource: FormResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Form(resource, ctx);
}
