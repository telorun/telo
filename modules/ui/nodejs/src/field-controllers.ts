import type { ResourceContext, TextRecord } from "@telorun/sdk";
import { quotedText, sameWritten } from "./spec-texts.js";
import { controlFits, type Control } from "./control-fit.js";
import {
  baseSpec,
  choiceControlProblem,
  choiceFits,
  controlProblem,
  fieldController,
  optionValueMismatch,
  optionValueProblem,
  type FieldProblem,
  type FieldResource,
} from "./field-answer.js";
import type { JsonSchema } from "./model-schema.js";
import { isOptionSource, type OptionSourceSpec } from "./option-source.js";
import { dialogSpec, isSurface } from "./surface-spec.js";

type Unit = "day" | "week" | "month" | "quarter" | "year";

const options = (value: unknown, resource: FieldResource, ctx: ResourceContext): Promise<OptionSourceSpec> =>
  ctx
    .resolveRef(value, isOptionSource, () => `'options' of Ui field '${resource.metadata.name}'`, "Ui.OptionSource")
    .provide();

export const InputFieldController = fieldController<FieldResource & { control?: Control | null }>(async (resource, property) => {
  const control = resource.control ?? "auto";
  const problems = controlFits(control, property, null) ? [] : [controlProblem(control, resource.property)];
  return { problems, spec: { ...baseSpec("input", resource, property), control } };
});

export const ChoiceFieldController = fieldController<FieldResource & { options: unknown; control?: Control | null }>(
  async (resource, property, ctx) => {
    const control = resource.control ?? "auto";
    const source = await options(resource.options, resource, ctx);
    const problems: FieldProblem[] = [];
    if (!choiceFits(control, property)) problems.push(choiceControlProblem(control, resource.property));
    if (optionValueMismatch(property, source)) problems.push(optionValueProblem(resource.property));
    return { problems, spec: { ...baseSpec("choice", resource, property), control, options: source } };
  },
);

export const PickerFieldController = fieldController<FieldResource & { options: unknown; surface?: unknown }>(
  async (resource, property, ctx) => {
    const source = await options(resource.options, resource, ctx);
    const surface =
      resource.surface == null
        ? dialogSpec()
        : await ctx
            .resolveRef(resource.surface, isSurface, () => `'surface' of Ui.PickerField '${resource.metadata.name}'`, "Ui.Overlay")
            .provide();
    const problems = optionValueMismatch(property, source) ? [optionValueProblem(resource.property)] : [];
    return { problems, spec: { ...baseSpec("picker", resource, property), options: source, surface } };
  },
);

type DateRangeResource = FieldResource & {
  presets: { label: TextRecord; unit: Unit; offset: number | bigint }[];
  weekStart?: "monday" | "sunday" | null;
  initialPreset?: string | null;
  warnLongerThan?: { unit: Unit; count: number | bigint } | null;
};

/** Whether a property is one object of exactly `from` and `to`, each a date. */
function isDateRange(property: JsonSchema): boolean {
  const members = property.properties;
  if (property.type !== "object" || members === null || typeof members !== "object") return false;
  const names = Object.keys(members);
  return (
    names.length === 2 &&
    ["from", "to"].every(
      (name) => names.includes(name) && members[name]?.type === "string" && members[name]?.format === "date",
    )
  );
}

export const DateRangeFieldController = fieldController<DateRangeResource>(async (resource, property) => {
  const name = resource.property;
  const problems: FieldProblem[] = [];
  if (!isDateRange(property)) {
    problems.push({
      code: "UI_DATE_RANGE_PROPERTY_INVALID",
      message: `enters a property that is not a date range ('${name}'): an object of exactly 'from' and 'to', each 'type: string' with 'format: date'.`,
    });
  }
  const initial = resource.initialPreset ?? undefined;
  if (initial !== undefined && property.default !== undefined) {
    problems.push({
      code: "UI_DATE_RANGE_DEFAULT_CONFLICT",
      message: `starts at a preset while the model gives the property a 'default' too ('${name}'). Remove 'initialPreset', or the property's 'default'.`,
    });
  }
  const initialIndex = initial === undefined ? -1 : resource.presets.findIndex((preset) => preset.label.text === initial);
  if (initial !== undefined && initialIndex < 0) {
    problems.push({
      code: "UI_DATE_RANGE_PRESET_UNKNOWN",
      message: `starts at a preset it does not declare ('${initial}'). Name the label of one of its 'presets', or remove 'initialPreset'.`,
    });
  }
  const duplicate = resource.presets.find((preset, index) => resource.presets.findIndex((other) => sameWritten(other.label, preset.label)) !== index);
  if (duplicate) {
    problems.push({
      code: "UI_DATE_RANGE_PRESET_LABEL_DUPLICATE",
      message: `has two presets labelled ${quotedText(duplicate.label)}. A preset is chosen by its label: give each its own.`,
    });
  }
  const warn = resource.warnLongerThan ?? undefined;
  return {
    problems,
    spec: {
      ...baseSpec("dateRange", resource, property),
      presets: resource.presets.map(({ label, unit, offset }) => ({ label, unit, offset: Number(offset) })),
      weekStart: resource.weekStart ?? "monday",
      initialPreset: initialIndex < 0 ? null : initialIndex,
      ...(warn ? { warnLongerThan: { unit: warn.unit, count: Number(warn.count) } } : {}),
    },
  };
});
