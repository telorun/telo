import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { controlFits, type Control } from "./control-fit.js";
import { labelOf, plainTypes, type JsonSchema } from "./model-schema.js";
import { descriptionOf, labelsOf, type SpecText } from "./spec-texts.js";
import type { OptionSourceSpec } from "./option-source.js";
import { isChain, type Condition } from "./row-binding.js";

/** Why a field cannot enter its property in the model it was handed. */
export interface FieldProblem {
  code: string;
  message: string;
}

/** A field as a renderer receives it: a `Ui.SpecNode` `Field` branch. */
export type FieldSpec = { type: string; property: string; label: SpecText } & Record<string, unknown>;

/** What a `Ui.Field` answers for a model: `spec` exactly when the model
 *  declares the property and `problems` is empty. */
export interface FieldAnswer {
  property: string;
  problems: FieldProblem[];
  spec?: FieldSpec;
}

/** Anything a `fields` entry that is not a property name holds. */
export interface FieldInstance {
  invoke(inputs: { model: JsonSchema }): Promise<FieldAnswer>;
}

export function isField(candidate: unknown): candidate is FieldInstance {
  return typeof (candidate as FieldInstance | null)?.invoke === "function";
}

/** What every field kind is declared with. A member holding nothing is one left out. */
export type FieldResource = RuntimeResource & {
  property: string;
  group?: string | null;
  shown?: Condition | null;
};

/** The members every field spec carries. */
export function baseSpec(type: string, resource: FieldResource, property: JsonSchema): FieldSpec {
  return {
    type,
    property: resource.property,
    label: labelOf(resource.property, property),
    description: descriptionOf(property),
    labels: labelsOf(property),
    ...(resource.group != null ? { group: resource.group } : {}),
    ...(resource.shown != null ? { shown: resource.shown } : {}),
  };
}

/** A field kind's controller over the one function that judges a model
 *  property and builds the spec. */
export function fieldController<R extends FieldResource>(
  answer: (resource: R, property: JsonSchema, ctx: ResourceContext) => Promise<{ problems: FieldProblem[]; spec: FieldSpec }>,
) {
  return {
    async create(resource: R, ctx: ResourceContext): Promise<ResourceInstance> {
      return {
        async invoke({ model }: { model: JsonSchema }): Promise<FieldAnswer> {
          const properties = (model?.properties ?? {}) as Record<string, JsonSchema>;
          if (!Object.hasOwn(properties, resource.property)) return { property: resource.property, problems: [] };
          const { problems, spec } = await answer(resource, properties[resource.property], ctx);
          return problems.length > 0 ? { property: resource.property, problems } : { property: resource.property, problems, spec };
        },
      };
    },
  };
}

export const controlProblem = (control: Control, name: string): FieldProblem => ({
  code: "UI_FIELD_CONTROL_UNSUPPORTED",
  message: `asks for a control its property cannot be entered with ('${control}' for '${name}'). Every control needs one plain value or a list of them; 'select' and 'options' need an 'enum' or a boolean, 'toggle' a boolean, 'slider' a number declaring 'minimum' and 'maximum', and 'tags' a list.`,
});

export const choiceControlProblem = (control: string, name: string): FieldProblem => ({
  code: "UI_FIELD_CONTROL_UNSUPPORTED",
  message: `asks for a control a choice cannot be drawn with, or for a property no choice can enter ('${control}' for '${name}'). A choice is a 'select' list or 'options' side by side, over a string, a number, a boolean, or a list of those.`,
});

/** Whether a choice can be drawn with its control over a property. */
export const choiceFits = (control: string, property: JsonSchema): boolean =>
  ["auto", "select", "options"].includes(control) && controlFits("auto", property, null);

/** Whether a source's options hold values of another type than the property —
 *  or than its items, for a list. Judged where both declare their types. */
export function optionValueMismatch(property: JsonSchema, options: OptionSourceSpec): boolean {
  const value = options.value;
  if (!isChain(value) || value.path.length !== 1) return false;
  const read = (options.schema.properties as Record<string, JsonSchema> | undefined)?.[value.path[0]];
  if (!read) return false;
  const items = property.items;
  const element =
    plainTypes(property).join() === "array" ? (items !== null && typeof items === "object" && !Array.isArray(items) ? items : {}) : property;
  const want = plainTypes(element);
  const have = plainTypes(read);
  return want.length > 0 && have.length > 0 && !have.every((type) => want.includes(type) || (type === "integer" && want.includes("number")));
}

export const optionValueProblem = (name: string): FieldProblem => ({
  code: "UI_FIELD_OPTION_VALUE_MISMATCH",
  message: `offers options whose value is of another type than the property holds, or than its items hold for a list ('${name}'). Make the source's 'value' read a property of the property's type, or enter another property.`,
});
