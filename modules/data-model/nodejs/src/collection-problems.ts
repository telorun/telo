import type { AcceptedQuery, JsonSchema, RelationTarget } from "./collection-types.js";
import { isOrdered, isScalar, isText, modelProperties, relationValueTypes, type ModelProperty } from "./model-properties.js";

export interface CollectionProblem {
  code: string;
  message: string;
}

/** Whether a property's type carries an operator — the list endpoint's own test. */
const OPERATOR_APPLIES: Record<string, (property: ModelProperty) => boolean> = {
  eq: isScalar,
  in: isScalar,
  contains: isText,
  gt: isOrdered,
  gte: isOrdered,
  lt: isOrdered,
  lte: isOrdered,
  // A record can lack the property only where the model lets it.
  absent: (property) => !property.required || property.nullable,
};

/** A query parameter the list endpoint reads itself. */
const isReservedName = (name: string) =>
  ["limit", "cursor", "sort", "facet"].includes(name) || name.startsWith("_telo");

const sameTypes = (a: string[], b: string[]) => a.every((type) => b.includes(type)) && b.every((type) => a.includes(type));

/**
 * What must hold of a collection's declared key, query and relations against
 * its model, each with the sentence the static rule of the same name reports.
 * A kind extending the collection runs this beside its own checks.
 */
export function collectionProblems(
  model: JsonSchema,
  key: string,
  query: AcceptedQuery,
  relations: Record<string, RelationTarget>,
): CollectionProblem[] {
  const problems: CollectionProblem[] = [];
  const typed = modelProperties(model);
  const required: unknown[] = Array.isArray(model.required) ? model.required : [];
  if (!typed.has(key) || !required.includes(key)) {
    problems.push({
      code: "DATA_MODEL_KEY_UNDECLARED",
      message: `'model' does not declare a required '${key}'. Every record carries its key: add '${key}' to the model's properties and to its 'required', or name the property that identifies a record in 'key'.`,
    });
  }
  for (const [index, { property, operator }] of query.filters.entries()) {
    if (isReservedName(property)) {
      problems.push({
        code: "DATA_MODEL_FILTER_RESERVED_NAME",
        message: `'query.filters[${index}]' filters by '${property}', named as a query parameter the list endpoint owns: 'limit', 'cursor', 'sort', 'facet', and every name beginning '_telo'. Rename the property, or leave it out of 'query.filters'.`,
      });
    }
    const declared = typed.get(property);
    if (!declared) {
      problems.push({
        code: "DATA_MODEL_FILTER_UNKNOWN_PROPERTY",
        message: `'query.filters[${index}]' filters by '${property}', which 'model' does not declare. Use a property of 'model', or add this one to it.`,
      });
      continue;
    }
    if (!OPERATOR_APPLIES[operator]?.(declared)) {
      problems.push({
        code: "DATA_MODEL_FILTER_OPERATOR_UNSUPPORTED",
        message: `'query.filters[${index}]' uses an operator the property's type does not support ('${operator}' on '${property}', declared ${declared.types.join(" or ") || "untyped"}): 'contains' needs a string, 'gt' / 'gte' / 'lt' / 'lte' a string or a number, 'absent' a property the model leaves optional or admits null, and no operator applies to an object or a list.`,
      });
    }
  }
  for (const [list, code, verb] of [
    [query.sort, "SORT", "sorts"],
    [query.facets, "FACET", "facets"],
  ] as const) {
    const field = code === "SORT" ? "sort" : "facets";
    for (const [index, { property }] of list.entries()) {
      const declared = typed.get(property);
      if (!declared) {
        problems.push({
          code: `DATA_MODEL_${code}_UNKNOWN_PROPERTY`,
          message: `'query.${field}[${index}]' ${verb} by '${property}', which 'model' does not declare. Use a property of 'model', or add this one to it.`,
        });
      } else if (!isScalar(declared)) {
        problems.push({
          code: `DATA_MODEL_${code}_UNSUPPORTED`,
          message: `'query.${field}[${index}]' ${verb} by '${property}', which holds an object or a list. Use a string, number or boolean property: one plain value.`,
        });
      }
    }
  }
  for (const [property, target] of Object.entries(relations)) {
    if (!typed.has(property)) {
      problems.push({
        code: "DATA_MODEL_RELATION_UNKNOWN_PROPERTY",
        message: `'relations.${property}' names a property 'model' does not declare. Use a property of 'model', or add this one to it.`,
      });
      continue;
    }
    const own = relationValueTypes(model, property);
    const theirs = relationValueTypes(target.model, target.key);
    if (own.length > 0 && theirs.length > 0 && !sameTypes(own, theirs)) {
      problems.push({
        code: "DATA_MODEL_RELATION_VALUE_MISMATCH",
        message: `'relations.${property}' holds ${own.join(" or ")}, and the target's key '${target.key}' is ${theirs.join(" or ")}. A relation's value is the target's key: declare the same type.`,
      });
    }
    if (!target.query.filters.some((filter) => filter.property === target.key && filter.operator === "in")) {
      problems.push({
        code: "DATA_MODEL_RELATION_KEY_NOT_FILTERABLE",
        message: `'relations.${property}' points at a collection that does not accept '${target.key}' with 'in', so related records cannot be fetched in one batched request. Add { property: ${target.key}, operator: in } to its 'query.filters'.`,
      });
    }
  }
  return problems;
}
