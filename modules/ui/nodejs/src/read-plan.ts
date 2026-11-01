import { enumerable, spanFormat, type ReadKeys } from "./layout-fit.js";
import type { LayoutInputs } from "./listing-layout.js";
import { modelShape, schemaAt, shapeLabels, type JsonSchema, type ShapeReader } from "./model-schema.js";
import type { ValueLabel } from "./spec-texts.js";

/** `reads.groups` as a renderer receives it. */
export interface GroupsPlan {
  property: string;
  values: "all" | "present";
  enum?: (string | number | boolean)[];
  relation?: string;
  labels: ValueLabel[];
}

/** A layout's read plan as a renderer receives it, every default filled. */
export interface ReadPlan {
  groups?: GroupsPlan;
  span?: { start: string; end?: string; format: "date" | "date-time" };
  parent?: string;
}

/** The values a property can hold, `null` aside: its `enum`, or a boolean's two. */
function enumeratedValues(property: JsonSchema): (string | number | boolean)[] | undefined {
  if (Array.isArray(property.enum)) {
    return property.enum.flatMap((value: unknown) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [value]
        : typeof value === "bigint"
          ? [Number(value)]
          : [],
    );
  }
  return enumerable(property) ? [true, false] : undefined;
}

/**
 * The read plan of a layout reading records by `keys`, for a listing whose fit
 * `layoutProblems` found nothing wrong with: a grouping's values — listed, or
 * paged from the presented relation — and labels, a span's format.
 */
export function readPlan(keys: ReadKeys, inputs: LayoutInputs, reader: ShapeReader): ReadPlan {
  const plan: ReadPlan = {};
  const properties = (inputs.model.properties ?? {}) as Record<string, JsonSchema>;
  const groups = keys.groups ?? undefined;
  if (groups) {
    const property = properties[groups.property]!;
    const values = groups.values ?? "all";
    const listed = values === "all" ? enumeratedValues(property) : undefined;
    const target = schemaAt(modelShape(inputs.model, reader, "model"), [groups.property], reader, "model");
    plan.groups = {
      property: groups.property,
      values,
      ...(listed ? { enum: listed } : {}),
      ...(Object.hasOwn(inputs.relations, groups.property) ? { relation: groups.property } : {}),
      labels: shapeLabels(target),
    };
  }
  const span = keys.span ?? undefined;
  if (span) {
    plan.span = {
      start: span.start,
      ...(span.end != null ? { end: span.end } : {}),
      format: spanFormat(properties[span.start])!,
    };
  }
  if (keys.parent != null) plan.parent = keys.parent;
  return plan;
}
