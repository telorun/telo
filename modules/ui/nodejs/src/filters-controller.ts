import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource, type TextRecord } from "@telorun/sdk";
import { labelsOf, quotedText, sameWritten, type ValueLabel } from "./spec-texts.js";
import type { Provided, SpecNode } from "./composite.js";
import { presentationAt } from "./collection-presentation.js";
import type { AcceptedQuery, Operator } from "./collection-source.js";
import { optionValueMismatch } from "./field-answer.js";
import { abovePlacement, isFilterPlacement } from "./filter-placement.js";
import { labelOf, type JsonSchema } from "./model-schema.js";
import { isOptionSource, type OptionSourceSpec } from "./option-source.js";
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
  values?: "all" | "present";
  options?: unknown;
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
  presentation: unknown;
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
  values: "all" | "present";
  options?: OptionSourceSpec;
  default?: Scalar[];
}

export interface FilterPreset {
  label: TextRecord;
  values: { property: string; operator: Operator; value: Scalar[] }[];
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
  if (operator === "absent") return typeof declared === "boolean" ? [declared] : undefined;
  if (Array.isArray(declared) !== (operator === "in")) return undefined;
  const values = [declared].flat().map(plain);
  return values.every((value) => valueFits(property, value)) ? (values as Scalar[]) : undefined;
}

/** Whether a value asks a switch to be off: it is on, or it holds nothing.
 *  A filter under `absent` is entered with a switch whatever its control. */
const switchedOff = (control: Control, operator: Operator, held: Scalar[]): boolean =>
  (control === "toggle" || operator === "absent") && held.includes(false);

/** Where a field's choices come from, when they are records: its own option
 *  source by field index, else the property's relation. */
export interface FieldChoices {
  overrides: ReadonlyMap<number, OptionSourceSpec>;
  relations: Readonly<Record<string, OptionSourceSpec>>;
}

const NO_CHOICES: FieldChoices = { overrides: new Map(), relations: {} };

/** The filters a bar shows: the ones listed, or every one the collection
 *  accepts, in the order it declares them. The collection's own guards hold
 *  every accepted filter to its model, so a filter it accepts names a declared
 *  property with an operator that fits it. */
export function filterFields(
  schema: JsonSchema,
  query: AcceptedQuery,
  listed: FieldConfig[] | undefined | null,
  owner: string,
  choices: FieldChoices = NO_CHOICES,
): FilterField[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const field = ({ property, operator, pinned, control, values }: FieldConfig, index: number | undefined, held?: Scalar[]): FilterField => {
    const options = (index === undefined ? undefined : choices.overrides.get(index)) ?? choices.relations[property];
    return {
      property,
      operator,
      label: labelOf(property, properties[property]),
      labels: labelsOf(properties[property]),
      schema: properties[property],
      pinned: pinned === true,
      control: control ?? "auto",
      values: values ?? "all",
      ...(options ? { options } : {}),
      ...(held === undefined ? {} : { default: held }),
    };
  };
  if (!listed) return query.filters.map((filter) => field(filter, undefined));
  return listed.map((config, index) => {
    const { property, operator } = config;
    if (listed.findIndex((other) => other.property === property && other.operator === operator) !== index) {
      throw new RuntimeError(
        "ERR_UI_FILTER_DUPLICATE",
        `${owner}: 'fields[${index}]' lists a property and operator another field already has ('${operator}' on '${property}'). A filter is one property with one operator: remove one of the two.`,
      );
    }
    if (!query.filters.some((filter) => filter.property === property && filter.operator === operator)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_NOT_ACCEPTED",
        `${owner}: 'fields[${index}]' filters by a property and operator the collection does not accept ('${operator}' on '${property}'). Declare the pair under the collection's 'query.filters', or remove this field.`,
      );
    }
    if (config.values === "present" && !query.facets.some((facet) => facet.property === property)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_VALUES_NOT_FACETED",
        `${owner}: 'fields[${index}]' offers only the values present for a property the collection does not facet ('${property}'). Add the property to the collection's 'query.facets', or offer 'all' values.`,
      );
    }
    const override = choices.overrides.get(index);
    if (override && properties[property] && optionValueMismatch(properties[property], override)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_OPTION_VALUE_MISMATCH",
        `${owner}: 'fields[${index}]' offers options whose value is of another type than the property holds ('${property}'). Make the source's 'value' read a property of the property's type, or filter another property.`,
      );
    }
    const control = config.control ?? "auto";
    if (control !== "auto" && control !== "none" && !controlFits(control, properties[property], operator)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_CONTROL_UNSUPPORTED",
        `${owner}: 'fields[${index}]' asks for a control its filter cannot be entered with ('${control}' for '${operator}' on '${property}'): 'select' and 'options' need an 'enum' or a boolean, 'toggle' a boolean with 'eq' or any property under 'absent', 'slider' a number or integer declaring 'minimum' and 'maximum' with 'eq' or a comparison, and 'tags' the 'in' operator.`,
      );
    }
    if (config.default == null) return field(config, index);
    const held = heldValues(properties[property], operator, config.default);
    if (!held || switchedOff(control, operator, held)) {
      throw new RuntimeError(
        "ERR_UI_FILTER_DEFAULT_INVALID",
        `${owner}: 'fields[${index}]' declares a default its filter cannot hold ('${operator}' on '${property}'): a value that is not of the property's type or not one of its 'enum', a list without the 'in' operator, a single value with it, anything but 'true' under 'absent', or 'false' for a filter entered with a 'toggle', which holds true or nothing.`,
      );
    }
    return field(config, index, held);
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
      if (!held || switchedOff(shown.control, operator, held)) {
        throw new RuntimeError(
          "ERR_UI_FILTER_PRESET_VALUE_INVALID",
          `${owner}: 'presets[${index}]' sets a value its filter cannot hold ('${operator}' on '${property}'): one that is not of the property's type or not one of its 'enum', a list without the 'in' operator, a single value with it, anything but 'true' under 'absent', or 'false' for a filter entered with a 'toggle', which holds true or nothing.`,
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
    const { basePath, collection, relations } = presentationAt(this.resource.presentation, this.ctx, owner);
    const schema = collection.model;
    const overrides = new Map<number, OptionSourceSpec>();
    for (const [index, config] of (this.resource.fields ?? []).entries()) {
      if (config.options == null) continue;
      const source = this.ctx.resolveRef(config.options, isOptionSource, () => `'fields[${index}].options' of ${owner}`, "Ui.OptionSource");
      overrides.set(index, await source.provide());
    }
    const fields = filterFields(schema, collection.query, this.resource.fields, owner, { overrides, relations });
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
      basePath,
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
