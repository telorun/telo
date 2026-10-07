import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { Provided, SpecNode } from "./composite.js";
import { isScalar, labelOf, modelSchema, plainTypes, propertiesOf, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";

export type Operator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in";

interface FieldConfig {
  property: string;
  operator?: Operator;
}

type FiltersResource = RuntimeResource & {
  model: unknown;
  fields?: FieldConfig[];
  content: AuthoredNode;
};

export interface FilterField {
  property: string;
  operator: Operator;
  label: string;
  schema: JsonSchema;
}

const ACCEPTS: Record<Operator, string[]> = {
  eq: ["string", "number", "integer", "boolean"],
  in: ["string", "number", "integer", "boolean"],
  contains: ["string"],
  gt: ["string", "number", "integer"],
  gte: ["string", "number", "integer"],
  lt: ["string", "number", "integer"],
  lte: ["string", "number", "integer"],
};

/** The operator a property filters by when none is written. */
export function defaultOperator(property: JsonSchema): Operator {
  if (Array.isArray(property.enum)) return "in";
  return plainTypes(property).includes("string") ? "contains" : "eq";
}

/** The filters a bar shows: the ones listed, or one per scalar property. */
export function filterFields(schema: JsonSchema, listed: FieldConfig[] | undefined, owner: string): FilterField[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const field = (name: string, operator?: Operator): FilterField => ({
    property: name,
    operator: operator ?? defaultOperator(properties[name]),
    label: labelOf(name, properties[name]),
    schema: properties[name],
  });
  if (!listed) {
    return propertiesOf(schema)
      .filter(([, property]) => isScalar(property))
      .map(([name]) => field(name));
  }
  return listed.map(({ property, operator }, index) => {
    if (!(property in properties)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_UNKNOWN_PROPERTY",
        `${owner}: 'fields[${index}]' filters by a property the model does not declare ('${property}'). Use a property of 'model', or add this one to it.`,
      );
    }
    const declared = properties[property].type;
    // Judged where the property declares one plain type, as the static rule is.
    if (typeof declared === "string" && !ACCEPTS[operator ?? "eq"].includes(declared)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_OPERATOR_UNSUPPORTED",
        `${owner}: 'fields[${index}]' uses an operator the property's type does not support ('${operator ?? "eq"}' on '${property}', declared ${declared}): 'contains' needs a string, 'gt' / 'gte' / 'lt' / 'lte' a string or a number, and no operator applies to an object or a list.`,
      );
    }
    return field(property, operator);
  });
}

class Filters implements ResourceInstance {
  constructor(
    private readonly resource: FiltersResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const owner = `Ui.Filters '${this.resource.metadata.name}'`;
    const schema = modelSchema(this.resource.model, this.ctx, owner);
    const fields = filterFields(schema, this.resource.fields, owner);
    const content = await resolveNode(this.resource.content, this.ctx, `${owner} content`);
    // Filters over nothing are nothing.
    if (!content?.node) return { assets: [] };
    const node: SpecNode = { type: "filters", fields, content: content.node };
    return { node, assets: content.assets };
  }
}

export async function create(resource: FiltersResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Filters(resource, ctx);
}
