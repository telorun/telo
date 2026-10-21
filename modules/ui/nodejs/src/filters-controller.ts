import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource, type TextRecord } from "@telorun/sdk";
import { labelsOf, quotedText, sameWritten, type ValueLabel } from "./spec-texts.js";
import type { Provided, SpecNode } from "./composite.js";
import { isCollection, type CollectionQuery, type Operator } from "./collection-controller.js";
import { abovePlacement, isFilterPlacement } from "./filter-placement.js";
import { labelOf, modelSchema, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import { controlFits, type Control } from "./control-fit.js";
import { stateSpec, type StateConfig } from "./state-record.js";

type Scalar = string | number | boolean;

/** One filter as listed. A member holding nothing is one left out. */
interface FieldConfig {
  property: string;
  operator: Operator;
  pinned?: boolean;
  control?: Control;
  default?: unknown;
}

interface PresetConfig {
  label: TextRecord;
  values: { property: string; operator: Operator; value: unknown }[];
}

/** The bar's policy as written. A member holding nothing is one left out. */
interface PolicyConfig {
  show?: string;
  placement?: unknown;
  controls?: string;
  apply?: string;
  summary?: string;
  state?: StateConfig;
}

type FiltersResource = RuntimeResource & {
  model: unknown;
  collection: unknown;
  fields?: FieldConfig[];
  presets?: PresetConfig[];
  policy?: PolicyConfig;
  content: AuthoredNode;
};

export interface FilterField {
  property: string;
  operator: Operator;
  label: TextRecord;
  labels: ValueLabel[];
  schema: JsonSchema;
  pinned: boolean;
  control: Control;
  default?: Scalar[];
}

export interface FilterPreset {
  label: TextRecord;
  values: { property: string; operator: Operator; value: Scalar[] }[];
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

/** Whether a property's declared type carries an operator. Judged where the
 *  property declares one plain type, as the static rules are. */
function operatorFits(property: JsonSchema, operator: Operator): boolean {
  const declared = property.type;
  return typeof declared !== "string" || ACCEPTS[operator].includes(declared);
}

/** A declared value as plain data: an integer an expression computed arrives wide. */
const plain = (value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value);

/** Whether one value is of a property's type and one of its `enum`. The type is
 *  judged where the property declares one plain type, as an operator is. */
function valueFits(property: JsonSchema, value: unknown): boolean {
  if (Array.isArray(property.enum) && !property.enum.some((allowed: unknown) => plain(allowed) === value)) return false;
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      return true;
  }
}

/** What a filter holds for a declared value — always a list — or nothing when
 *  the filter cannot hold it: a list without `in`, one value with it, or a
 *  value its property refuses. */
export function heldValues(property: JsonSchema, operator: Operator, declared: unknown): Scalar[] | undefined {
  if (Array.isArray(declared) !== (operator === "in")) return undefined;
  const values = [declared].flat().map(plain);
  return values.every((value) => valueFits(property, value)) ? (values as Scalar[]) : undefined;
}

/** Whether a value asks a switch to be off: it is on, or it holds nothing. */
const switchedOff = (control: Control, held: Scalar[]): boolean => control === "toggle" && held.includes(false);

/** The filters a bar shows: the ones listed, or every one the collection
 *  accepts, in the order it declares them. */
export function filterFields(
  schema: JsonSchema,
  accepted: CollectionQuery["filters"],
  listed: FieldConfig[] | undefined,
  owner: string,
): FilterField[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const field = ({ property, operator, pinned, control }: FieldConfig, held?: Scalar[]): FilterField => ({
    property,
    operator,
    label: labelOf(property, properties[property]),
    labels: labelsOf(properties[property]),
    schema: properties[property],
    pinned: pinned === true,
    control: control ?? "auto",
    ...(held === undefined ? {} : { default: held }),
  });
  if (!listed) {
    const incomplete = (reason: string) =>
      new RuntimeError(
        "ERR_UI_FILTER_MODEL_INCOMPLETE",
        `${owner}: shows every filter the collection accepts, and the model cannot answer for one of them: ${reason}. Give the bar a model that can, or list the filters to show under 'fields'.`,
      );
    for (const { property, operator } of accepted) {
      if (!Object.hasOwn(properties, property)) throw incomplete(`it does not declare '${property}'`);
      if (!operatorFits(properties[property], operator)) {
        throw incomplete(`'${operator}' does not fit '${property}', declared ${properties[property].type}`);
      }
    }
    return accepted.map((filter) => field(filter));
  }
  return listed.map((config, index) => {
    const { property, operator } = config;
    if (listed.findIndex((other) => other.property === property && other.operator === operator) !== index) {
      throw new RuntimeError(
        "ERR_UI_FILTER_DUPLICATE",
        `${owner}: 'fields[${index}]' lists a property and operator another field already has ('${operator}' on '${property}'). A filter is one property with one operator: remove one of the two.`,
      );
    }
    if (!Object.hasOwn(properties, property)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_UNKNOWN_PROPERTY",
        `${owner}: 'fields[${index}]' filters by a property the model does not declare ('${property}'). Use a property of 'model', or add this one to it.`,
      );
    }
    if (!operatorFits(properties[property], operator)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_OPERATOR_UNSUPPORTED",
        `${owner}: 'fields[${index}]' uses an operator the property's type does not support ('${operator}' on '${property}', declared ${properties[property].type}): 'contains' needs a string, 'gt' / 'gte' / 'lt' / 'lte' a string or a number, and no operator applies to an object or a list.`,
      );
    }
    if (!accepted.some((filter) => filter.property === property && filter.operator === operator)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_NOT_ACCEPTED",
        `${owner}: 'fields[${index}]' filters by a property and operator the collection does not accept ('${operator}' on '${property}'). Declare the pair under the collection's 'query.filters', or remove this field.`,
      );
    }
    const control = config.control ?? "auto";
    if (control !== "auto" && control !== "none" && !controlFits(control, properties[property], operator)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_CONTROL_UNSUPPORTED",
        `${owner}: 'fields[${index}]' asks for a control its filter cannot be entered with ('${control}' for '${operator}' on '${property}'): 'select' and 'options' need an 'enum' or a boolean, 'toggle' a boolean with 'eq', 'slider' a number or integer declaring 'minimum' and 'maximum' with 'eq' or a comparison, and 'tags' the 'in' operator.`,
      );
    }
    if (config.default === undefined) return field(config);
    const held = heldValues(properties[property], operator, config.default);
    if (!held || switchedOff(control, held)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_DEFAULT_INVALID",
        `${owner}: 'fields[${index}]' declares a default its filter cannot hold ('${operator}' on '${property}'): a value that is not of the property's type or not one of its 'enum', a list without the 'in' operator, a single value with it, or 'false' for a filter entered with a 'toggle', which holds true or nothing.`,
      );
    }
    return field(config, held);
  });
}

/** The presets as a renderer receives them, each value a list. */
export function filterPresets(fields: FilterField[], declared: PresetConfig[] | undefined, owner: string): FilterPreset[] {
  return (declared ?? []).map((preset, index) => {
    if (declared?.findIndex((other) => sameWritten(other.label, preset.label)) !== index) {
      throw new RuntimeError(
        "ERR_UI_FILTER_PRESET_LABEL_DUPLICATE",
        `${owner}: 'presets[${index}]' has the label of another preset (${quotedText(preset.label)}). A preset is chosen by its label: give each its own.`,
      );
    }
    const values = preset.values.map(({ property, operator, value }) => {
      const shown = fields.find((field) => field.property === property && field.operator === operator);
      if (!shown) {
        throw new RuntimeError(
          "ERR_UI_FILTER_PRESET_UNKNOWN_FILTER",
          `${owner}: 'presets[${index}]' sets a property and operator the bar does not show ('${operator}' on '${property}'). Name a pair listed under 'fields', or one the collection accepts when 'fields' is left out.`,
        );
      }
      const held = heldValues(shown.schema, operator, value);
      if (!held || switchedOff(shown.control, held)) {
        throw new RuntimeError(
          "ERR_UI_FILTER_PRESET_VALUE_INVALID",
          `${owner}: 'presets[${index}]' sets a value its filter cannot hold ('${operator}' on '${property}'): one that is not of the property's type or not one of its 'enum', a list without the 'in' operator, a single value with it, or 'false' for a filter entered with a 'toggle', which holds true or nothing.`,
        );
      }
      return { property, operator, value: held };
    });
    return { label: preset.label, values };
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
    const collection = this.ctx.resolveRef(
      this.resource.collection,
      isCollection,
      () => `'collection' of ${owner}`,
      "Ui.Collection",
    );
    const fields = filterFields(schema, collection.query.filters, this.resource.fields, owner);
    const presets = filterPresets(fields, this.resource.presets, owner);
    const content = await resolveNode(this.resource.content, this.ctx, `${owner} content`);
    // Filters over nothing are nothing.
    if (!content?.node) return { assets: [] };
    const policy = this.resource.policy ?? {};
    const placement =
      policy.placement === undefined
        ? abovePlacement()
        : await this.ctx
            .resolveRef(policy.placement, isFilterPlacement, () => `'policy.placement' of ${owner}`, "Ui.FilterPlacement")
            .provide();
    const state = await stateSpec(policy.state, fields.map((field) => field.property), schema, this.ctx, owner, "policy.state", "filter");
    const node: SpecNode = {
      type: "filters",
      fields,
      content: content.node,
      show: policy.show ?? "all",
      placement,
      controls: policy.controls ?? "direct",
      apply: policy.apply ?? "commit",
      summary: policy.summary ?? "none",
      state,
      presets,
    };
    return { node, assets: content.assets };
  }
}

export async function create(resource: FiltersResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Filters(resource, ctx);
}
