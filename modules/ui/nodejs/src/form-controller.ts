import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { isScalar, labelOf, modelSchema, propertiesOf, type JsonSchema } from "./model-schema.js";

type FormResource = RuntimeResource & {
  model: unknown;
  source: { basePath: string };
  fields?: { property: string }[];
};

/** The fields a form shows: the ones listed, or every scalar property. */
export function formFields(
  schema: JsonSchema,
  listed: { property: string }[] | undefined,
  owner: string,
): { property: string; label: string }[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  if (!listed) {
    return propertiesOf(schema)
      .filter(([, property]) => isScalar(property))
      .map(([name, property]) => ({ property: name, label: labelOf(name, property) }));
  }
  return listed.map(({ property }, index) => {
    if (!Object.hasOwn(properties, property)) {
      throw new RuntimeError(
        "ERR_UI_FORM_FIELD_UNKNOWN_PROPERTY",
        `${owner}: 'fields[${index}]' lists a field for a property the model does not declare ('${property}'). Use a property of 'model', or add this one to it.`,
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
