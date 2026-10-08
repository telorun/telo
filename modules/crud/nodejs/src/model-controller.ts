import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { AcceptedQuery } from "./collection-query.js";
import { isOrdered, isScalar, isText, KEY, modelProperties, type JsonSchema, type ModelProperty } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";

const OPERATIONS = ["read", "list", "create", "update"] as const;
type Operation = (typeof OPERATIONS)[number];

type ModelResource = RuntimeResource & { schemas: Record<Operation, unknown>; query: AcceptedQuery };

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> => schema.properties ?? {};
const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required : []);
/** A property's declared types, `null` aside. */
const plainTypes = (property: JsonSchema): string[] =>
  property?.type === undefined ? [] : [property.type].flat().filter((type: string) => type !== "null");

/** Whether a property's type carries an operator — the reader's own test. */
const OPERATOR_APPLIES: Record<string, (property: ModelProperty) => boolean> = {
  eq: isScalar,
  in: isScalar,
  contains: isText,
  gt: isOrdered,
  gte: isOrdered,
  lt: isOrdered,
  lte: isOrdered,
};

/** A query parameter the list route reads itself. */
const isReservedName = (name: string) => ["limit", "cursor", "sort"].includes(name) || name.startsWith("_telo");

/**
 * What must hold between the four shapes and of the declared query, each with
 * the sentence the static rule of the same name reports. Keep the two alike.
 */
export function shapeProblems(
  schemas: Record<Operation, JsonSchema>,
  query: AcceptedQuery,
): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = [];
  const readable = propertiesOf(schemas.read);
  for (const operation of ["read", "list"] as const) {
    if (!Object.hasOwn(propertiesOf(schemas[operation]), KEY) || !requiredOf(schemas[operation]).includes(KEY)) {
      problems.push({
        code: "CRUD_MODEL_KEY_UNDECLARED",
        message: `'schemas.${operation}' does not declare a required '${KEY}'. Every row read carries its key: add '${KEY}' to its properties and its 'required'.`,
      });
    }
  }
  for (const operation of ["create", "update"] as const) {
    if (Object.hasOwn(propertiesOf(schemas[operation]), KEY)) {
      problems.push({
        code: "CRUD_MODEL_KEY_WRITABLE",
        message: `'schemas.${operation}' declares '${KEY}'. The key is assigned by the table and named by the URL: remove it from this shape.`,
      });
    }
    if (schemas[operation].additionalProperties !== false) {
      problems.push({
        code: "CRUD_MODEL_WRITE_SHAPE_OPEN",
        message: `'schemas.${operation}' accepts properties it does not declare. A write body names columns: set 'additionalProperties: false' on it.`,
      });
    }
  }
  for (const operation of ["list", "create", "update"] as const) {
    for (const [name, property] of Object.entries(propertiesOf(schemas[operation]))) {
      if (!Object.hasOwn(readable, name)) {
        problems.push({
          code: "CRUD_MODEL_PROPERTY_NOT_READABLE",
          message: `'schemas.${operation}' declares '${name}', which 'schemas.read' does not. Every property of a record is one a read returns: add it to 'schemas.read', or remove it here.`,
        });
        continue;
      }
      const own = plainTypes(property);
      const read = plainTypes(readable[name]);
      if (own.length > 0 && read.length > 0 && own.join() !== read.join()) {
        problems.push({
          code: "CRUD_MODEL_PROPERTY_TYPE_DIFFERS",
          message: `'schemas.${operation}' types '${name}' as ${own.join(" or ")}, and 'schemas.read' as ${read.join(" or ")}. One column has one type: declare the same one in both.`,
        });
      }
    }
  }
  for (const name of requiredOf(schemas.update)) {
    if (Object.hasOwn(readable, name) && !requiredOf(schemas.read).includes(name)) {
      problems.push({
        code: "CRUD_MODEL_UPDATE_REQUIRES_OPTIONAL",
        message: `'schemas.update' requires '${name}', which 'schemas.read' leaves optional, so a record read without it could not be sent back. Require it in 'schemas.read' too, or make it optional here.`,
      });
    }
  }
  const typed = modelProperties(schemas.read);
  const typeText = (property: ModelProperty) => property.types.join(" or ");
  for (const [index, { property, operator }] of query.filters.entries()) {
    if (isReservedName(property)) {
      problems.push({
        code: "CRUD_MODEL_FILTER_RESERVED_NAME",
        message: `'query.filters[${index}]' filters by '${property}', named as a query parameter the list route owns: 'limit', 'cursor', 'sort', and every name beginning '_telo'. Rename the property, or leave it out of 'query.filters'.`,
      });
    }
    const declared = typed.get(property);
    if (!declared) {
      problems.push({
        code: "CRUD_MODEL_FILTER_UNKNOWN_PROPERTY",
        message: `'query.filters[${index}]' filters by '${property}', which 'schemas.read' does not declare. Use a property of 'schemas.read', or add this one to it.`,
      });
      continue;
    }
    if (!OPERATOR_APPLIES[operator]?.(declared)) {
      problems.push({
        code: "CRUD_MODEL_FILTER_OPERATOR_UNSUPPORTED",
        message: `'query.filters[${index}]' uses an operator the property's type does not support ('${operator}' on '${property}', declared ${typeText(declared)}): 'contains' needs a string, 'gt' / 'gte' / 'lt' / 'lte' a string or a number, and no operator applies to an object or a list.`,
      });
    }
  }
  for (const [index, { property }] of query.sort.entries()) {
    const declared = typed.get(property);
    if (!declared) {
      problems.push({
        code: "CRUD_MODEL_SORT_UNKNOWN_PROPERTY",
        message: `'query.sort[${index}]' sorts by '${property}', which 'schemas.read' does not declare. Use a property of 'schemas.read', or add this one to it.`,
      });
      continue;
    }
    if (!isScalar(declared)) {
      problems.push({
        code: "CRUD_MODEL_SORT_UNSUPPORTED",
        message: `'query.sort[${index}]' sorts by '${property}', which holds an object or a list. A list is ordered by one plain value: sort by a string, number or boolean property.`,
      });
    }
  }
  return problems;
}

/** The four shapes of one collection's records and what its list accepts, read
 *  once and checked against each other before anything is served from them. */
class Model implements ResourceInstance {
  private resolved?: Record<Operation, JsonSchema>;

  /** Read by whatever renders the collection. */
  get query(): AcceptedQuery {
    return this.resource.query;
  }

  constructor(
    private readonly resource: ModelResource,
    private readonly ctx: ResourceContext,
  ) {}

  private shapes(): Record<Operation, JsonSchema> {
    if (this.resolved) return this.resolved;
    const owner = `Crud.Model '${this.resource.metadata.name}'`;
    const schemas = Object.fromEntries(
      OPERATIONS.map((operation) => [
        operation,
        modelSchema(this.resource.schemas?.[operation], this.ctx, owner, `schemas.${operation}`),
      ]),
    ) as Record<Operation, JsonSchema>;
    const [problem] = shapeProblems(schemas, this.resource.query);
    if (problem) throw new RuntimeError(`ERR_${problem.code}`, `${owner}: ${problem.message}`);
    return (this.resolved = schemas);
  }

  init(): void {
    this.shapes();
  }

  snapshot(): Record<string, unknown> {
    const schemas = this.shapes();
    return {
      schemas: Object.fromEntries(OPERATIONS.map((operation) => [operation, { schema: schemas[operation] }])),
      query: this.resource.query,
    };
  }
}

export async function create(resource: ModelResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Model(resource, ctx);
}
