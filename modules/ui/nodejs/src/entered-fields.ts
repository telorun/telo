import { RuntimeError, type ResourceContext, type TextRecord } from "@telorun/sdk";
import { descriptionOf, labelsOf } from "./spec-texts.js";
import { controlFits } from "./control-fit.js";
import { isField, type FieldSpec } from "./field-answer.js";
import { isEnterable, labelOf, propertiesOf, type JsonSchema } from "./model-schema.js";
import type { OptionSourceSpec } from "./option-source.js";
import type { Condition } from "./row-binding.js";
import { dialogSpec } from "./surface-spec.js";

/** A `Ui.FieldGroup` as written. A member holding nothing is one left out. */
export interface GroupConfig {
  name: string;
  label: TextRecord;
  description?: TextRecord | null;
  shown?: Condition | null;
}

export interface GroupSpec {
  name: string;
  label: TextRecord;
  description?: TextRecord;
  shown?: Condition;
}

/** A bare property name's field: `{ kind: Ui.InputField, property }`. */
export const inputSpec = (name: string, property: JsonSchema | undefined): FieldSpec => ({
  type: "input",
  property: name,
  label: labelOf(name, property),
  description: descriptionOf(property),
  labels: labelsOf(property),
  control: "auto",
});

/** A bare property name's field where the property has a presented relation:
 *  a picker of the related records, in a dialog with its defaults. */
export const relationSpec = (name: string, property: JsonSchema | undefined, options: OptionSourceSpec): FieldSpec => ({
  type: "picker",
  property: name,
  label: labelOf(name, property),
  description: descriptionOf(property),
  labels: labelsOf(property),
  options,
  surface: dialogSpec(),
});

const propertySpec = (name: string, property: JsonSchema | undefined, relations: Readonly<Record<string, OptionSourceSpec>>): FieldSpec =>
  Object.hasOwn(relations, name) ? relationSpec(name, property, relations[name]) : inputSpec(name, property);

/** One field per property a control can enter, in declaration order. */
export const enterableSpecs = (schema: JsonSchema, relations: Readonly<Record<string, OptionSourceSpec>> = {}): FieldSpec[] =>
  propertiesOf(schema)
    .filter(([, property]) => isEnterable(property))
    .map(([name, property]) => propertySpec(name, property, relations));

const groupSpec = ({ name, label, description, shown }: GroupConfig): GroupSpec => ({
  name,
  label,
  ...(description != null ? { description } : {}),
  ...(shown != null ? { shown } : {}),
});

/**
 * The fields and groups a form or an action shows, each field asked through
 * its own kind whether it can enter its property in `schema`, and the whole
 * held to what an owner promises: every field names a declared property and
 * group, no property is entered twice, a group's fields are listed together
 * and every required property is entered. `slot` names the model slot. A
 * property named bare with a relation in `relations` is entered with a picker
 * of the related records.
 */
export async function enteredFields(
  schema: JsonSchema,
  listed: unknown[] | undefined | null,
  declaredGroups: GroupConfig[] | undefined | null,
  ctx: ResourceContext,
  owner: string,
  slot: "model" | "inputModel",
  relations: Readonly<Record<string, OptionSourceSpec>> = {},
): Promise<{ fields: FieldSpec[]; groups: GroupSpec[] }> {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const model = slot === "model" ? "the model" : "the input model";
  const groups = declaredGroups ?? [];
  groups.forEach((group, index) => {
    if (groups.findIndex((other) => other.name === group.name) !== index) {
      throw new RuntimeError(
        "ERR_UI_FIELD_GROUP_DUPLICATE",
        `${owner}: 'groups[${index}]' has the name of another group ('${group.name}'). A field names its group: give each its own.`,
      );
    }
  });
  const fields: FieldSpec[] = [];
  if (!listed) fields.push(...enterableSpecs(schema, relations));
  else {
    for (const [index, entry] of listed.entries()) {
      const at = `${owner}: 'fields[${index}]'`;
      let spec: FieldSpec;
      if (typeof entry === "string") {
        if (!Object.hasOwn(properties, entry)) {
          throw new RuntimeError(
            "ERR_UI_FIELD_UNKNOWN_PROPERTY",
            `${at} lists a field for a property ${model} does not declare ('${entry}'). Use a property of '${slot}', or add this one to it.`,
          );
        }
        if (!controlFits("auto", properties[entry], null)) {
          throw new RuntimeError(
            "ERR_UI_FIELD_UNSUPPORTED",
            `${at} lists a property no control can enter ('${entry}'). A property name enters a string, a number, a boolean, one of an 'enum', or a list of those: remove it, give '${slot}' a property of such a type, or name a field kind that enters it.`,
          );
        }
        spec = propertySpec(entry, properties[entry], relations);
      } else {
        const field = ctx.resolveRef(entry, isField, () => `'fields[${index}]' of ${owner}`, "Ui.Field");
        const answer = await field.invoke({ model: schema });
        const problem = answer.problems[0];
        if (problem) throw new RuntimeError(`ERR_${problem.code}`, `${at} ${problem.message}`);
        if (!Object.hasOwn(properties, answer.property)) {
          throw new RuntimeError(
            "ERR_UI_FIELD_UNKNOWN_PROPERTY",
            `${at} lists a field for a property ${model} does not declare ('${answer.property}'). Use a property of '${slot}', or add this one to it.`,
          );
        }
        if (!answer.spec) {
          throw new RuntimeError(
            "ERR_OUTPUT_INVALID",
            `${at} answered no field for '${answer.property}', which ${model} declares, and named no problem. A field answers a spec whenever it can enter its property.`,
          );
        }
        spec = answer.spec;
      }
      if (fields.some((other) => other.property === spec.property)) {
        throw new RuntimeError(
          "ERR_UI_FIELD_DUPLICATE",
          `${at} enters a property another field enters too ('${spec.property}'). Each property is entered by one field: remove one of the two.`,
        );
      }
      const group = spec.group as string | undefined;
      if (group !== undefined && !groups.some((declared) => declared.name === group)) {
        throw new RuntimeError(
          "ERR_UI_FIELD_GROUP_UNKNOWN",
          `${at} names a group 'groups' does not declare ('${group}'). Declare it under 'groups', or correct the name.`,
        );
      }
      fields.push(spec);
    }
  }
  groups.forEach((group, index) => {
    const starts = fields.filter((field, at) => field.group === group.name && (at === 0 || fields[at - 1].group !== group.name));
    if (starts.length > 1) {
      throw new RuntimeError(
        "ERR_UI_FIELD_GROUP_SPLIT",
        `${owner}: 'groups[${index}]' is named by fields that are not listed one after another ('${group.name}'). A group is drawn where its fields are: list them together.`,
      );
    }
  });
  const missing = ((Array.isArray(schema.required) ? schema.required : []) as string[]).filter(
    (required) => !fields.some((field) => field.property === required),
  );
  if (missing.length > 0) {
    throw new RuntimeError(
      "ERR_UI_FIELD_REQUIRED_NOT_ENTERED",
      `${owner}: leaves a property ${model} requires with no field (${missing.map((name) => `'${name}'`).join(", ")}), so a valid record could never be sent. List a field for every required property, or leave 'fields' out where each one is a scalar or a list of scalars.`,
    );
  }
  return { fields, groups: groups.map(groupSpec) };
}
