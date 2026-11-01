import { sameCollection, type Operator } from "./collection-source.js";
import type { LayoutInputs, LayoutProblem } from "./listing-layout.js";
import type { JsonSchema } from "./model-schema.js";

/** A layout's grouping as written; `values` holding nothing is one left out. */
export interface GroupingConfig {
  property: string;
  values?: "all" | "present" | null;
}

export interface SpanConfig {
  start: string;
  end?: string | null;
}

/** What a layout reads records by — the keys of `Ui.ListingLayoutSpec`'s `reads`. */
export interface ReadKeys {
  groups?: GroupingConfig | null;
  span?: SpanConfig | null;
  parent?: string | null;
}

const PLAIN = new Set(["string", "number", "integer", "boolean"]);

const propertyOf = (model: JsonSchema, name: string): JsonSchema | undefined =>
  Object.hasOwn(model.properties ?? {}, name) ? (model.properties as Record<string, JsonSchema>)[name] : undefined;

const declaredTypes = (property: JsonSchema): string[] =>
  property.type === undefined ? [] : [property.type].flat().filter((type: unknown) => type !== "null");

/** The types a property holds as a collection reads them: its `type`, else
 *  those of its `enum` values. */
function heldTypes(property: JsonSchema): string[] {
  if (property.type !== undefined) return declaredTypes(property);
  if (!Array.isArray(property.enum)) return [];
  return property.enum.flatMap((value: unknown) =>
    typeof value === "string" ? ["string"] : typeof value === "boolean" ? ["boolean"] : typeof value === "number" || typeof value === "bigint" ? ["number"] : [],
  );
}

/** The format a span bound is written in, or none when it is no date string. */
export function spanFormat(property: JsonSchema | undefined): "date" | "date-time" | undefined {
  if (!property) return undefined;
  const types = declaredTypes(property);
  if (types.length !== 1 || types[0] !== "string") return undefined;
  return property.format === "date" || property.format === "date-time" ? property.format : undefined;
}

/** Whether a property's values can be listed without a request: an `enum`, or a boolean's two. */
export const enumerable = (property: JsonSchema): boolean =>
  Array.isArray(property.enum) || (declaredTypes(property).length === 1 && declaredTypes(property)[0] === "boolean");

/**
 * Why a layout reading records by `keys` cannot draw the listing calling it —
 * the `UI_LAYOUT_*` referrer rules, judged here for a manifest that never
 * passed `telo check`. A property the model does not declare is judged once,
 * as unknown, and nothing else is said about it.
 */
export function layoutProblems(keys: ReadKeys, inputs: LayoutInputs): LayoutProblem[] {
  const { model, collection } = inputs;
  const problems: LayoutProblem[] = [];
  const accepts = (property: string, operator: Operator) =>
    collection.query.filters.some((filter) => filter.property === property && filter.operator === operator);
  const known = (name: string, key: string): JsonSchema | undefined => {
    const property = propertyOf(model, name);
    if (!property) {
      problems.push({
        code: "UI_LAYOUT_PROPERTY_UNKNOWN",
        message: `names a property the listing's model does not declare in '${key}' ('${name}'). Use a property of the listing's 'model', or add this one to it.`,
      });
    }
    return property;
  };

  const groups = keys.groups ?? undefined;
  if (groups) {
    const property = known(groups.property, "groups.property");
    const name = groups.property;
    if (property) {
      const types = heldTypes(property);
      if (types.length > 0 && !types.some((type) => PLAIN.has(type))) {
        problems.push({
          code: "UI_LAYOUT_GROUP_UNSUPPORTED",
          message: `groups records by a property that does not hold one plain value ('${name}') — a string, a number or a boolean — so no group can be read by equality. Group by a property holding one.`,
        });
      }
      if ((groups.values ?? "all") === "all" && !enumerable(property) && !Object.hasOwn(inputs.relations, name)) {
        problems.push({
          code: "UI_LAYOUT_GROUPS_NOT_ENUMERABLE",
          message: `draws every group of a property whose values cannot be listed ('${name}'): it declares no 'enum', is not a boolean, and the presentation presents no relation for it. Declare its values, present its relation, or draw 'values: present'.`,
        });
      }
    }
    if (!accepts(name, "eq")) {
      problems.push({
        code: "UI_LAYOUT_GROUP_NOT_FILTERABLE",
        message: `groups records by a property the collection does not accept an equality on ('${name}'), so no group can be read. Declare it with operator 'eq' under the collection's 'query.filters', or group by another property.`,
      });
    }
    if (groups.values === "present" && !collection.query.facets.some((facet) => facet.property === name)) {
      problems.push({
        code: "UI_LAYOUT_GROUPS_NOT_FACETED",
        message: `draws only the groups present for a property the collection does not facet ('${name}'), so their values cannot be read. List it under the collection's 'query.facets', or draw 'values: all'.`,
      });
    }
  }

  const span = keys.span ?? undefined;
  if (span) {
    const bounds = [span.start, ...(span.end != null ? [span.end] : [])];
    const properties = bounds.map((name, index) => known(name, index === 0 ? "span.start" : "span.end"));
    if (properties.every((property) => property !== undefined)) {
      const formats = properties.map(spanFormat);
      if (formats.some((format) => format === undefined || format !== formats[0])) {
        problems.push({
          code: "UI_LAYOUT_SPAN_NOT_DATE",
          message: `spans records by a property that is not a 'date' or 'date-time' string, or by a start and an end of different formats (${bounds.map((name) => `'${name}'`).join(", ")}), so no period bounds it. Span by date properties of one format.`,
        });
      }
    }
    const filterable =
      span.end != null ? accepts(span.start, "lte") && accepts(span.end, "gte") : accepts(span.start, "gte") && accepts(span.start, "lte");
    if (!filterable) {
      problems.push({
        code: "UI_LAYOUT_SPAN_NOT_FILTERABLE",
        message: `spans records by bounds the collection does not accept, so no period can be read. Without 'end' it needs '${span.start}' with 'gte' and 'lte'; with 'end', 'start' with 'lte' and 'end' with 'gte', under the collection's 'query.filters'.`,
      });
    }
  }

  const parent = keys.parent ?? undefined;
  if (parent !== undefined) {
    known(parent, "parent");
    const relation = collection.relations[parent];
    // A relation whose target cannot be followed is left to `telo check`.
    const self =
      relation !== undefined &&
      (relation.target === undefined || collection.identity === undefined || sameCollection(relation.target, collection.identity));
    if (!self) {
      problems.push({
        code: "UI_LAYOUT_PARENT_NOT_SELF_RELATION",
        message: `nests records under a property with no relation to the listing's own collection ('${parent}'), so a parent cannot be one of its records. Declare a relation from the property to this collection under its 'relations', or nest by another property.`,
      });
    }
    if (!accepts(parent, "eq") || !accepts(parent, "absent")) {
      problems.push({
        code: "UI_LAYOUT_PARENT_NOT_FILTERABLE",
        message: `nests records under a property the collection cannot read roots and children by ('${parent}'). Declare it with operators 'eq' and 'absent' under the collection's 'query.filters'.`,
      });
    }
  }
  return problems;
}
