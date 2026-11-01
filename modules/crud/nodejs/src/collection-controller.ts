import { collectionProblems, readCollection, type CollectionDeclaration } from "@telorun/data-model";
import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { DeclaredTable } from "@telorun/sql";
import { columnOf, KEY, type JsonSchema } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";
import { isDeclaredTable, rowColumns, targetTableName, type TableNameRead } from "./collection-table.js";

const OPERATIONS = ["list", "create", "update"] as const;
type Operation = (typeof OPERATIONS)[number];

type CollectionResource = RuntimeResource & {
  schemas?: Partial<Record<Operation, unknown>>;
  table?: unknown;
  relations?: Record<string, { collection?: unknown }>;
};

interface Problem {
  code: string;
  message: string;
}

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> => schema.properties ?? {};
const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required : []);
/** A property's declared types, `null` aside. */
const plainTypes = (property: JsonSchema): string[] =>
  property?.type === undefined ? [] : [property.type].flat().filter((type: string) => type !== "null");

/**
 * What must hold of the operation shapes against `model`, each with the
 * sentence the static rule of the same name reports. Keep the two alike.
 */
export function shapeProblems(model: JsonSchema, schemas: Record<Operation, JsonSchema>): Problem[] {
  const problems: Problem[] = [];
  const readable = propertiesOf(model);
  if (!Object.hasOwn(propertiesOf(schemas.list), KEY) || !requiredOf(schemas.list).includes(KEY)) {
    problems.push({
      code: "CRUD_COLLECTION_KEY_UNDECLARED",
      message: `'schemas.list' does not declare a required '${KEY}'. Every row read carries its key: add '${KEY}' to its properties and its 'required'.`,
    });
  }
  for (const operation of ["create", "update"] as const) {
    if (Object.hasOwn(propertiesOf(schemas[operation]), KEY)) {
      problems.push({
        code: "CRUD_COLLECTION_KEY_WRITABLE",
        message: `'schemas.${operation}' declares '${KEY}'. The key is assigned by the table and named by the URL: remove it from this shape.`,
      });
    }
    if (schemas[operation].additionalProperties !== false) {
      problems.push({
        code: "CRUD_COLLECTION_WRITE_SHAPE_OPEN",
        message: `'schemas.${operation}' accepts properties it does not declare. A write body names columns: set 'additionalProperties: false' on it.`,
      });
    }
  }
  for (const operation of OPERATIONS) {
    for (const [name, property] of Object.entries(propertiesOf(schemas[operation]))) {
      if (!Object.hasOwn(readable, name)) {
        problems.push({
          code: "CRUD_COLLECTION_PROPERTY_NOT_READABLE",
          message: `'schemas.${operation}' declares '${name}', which 'model' does not. Every property of a record is one a read returns: add it to 'model', or remove it here.`,
        });
        continue;
      }
      const own = plainTypes(property);
      const read = plainTypes(readable[name]);
      if (own.length > 0 && read.length > 0 && own.join() !== read.join()) {
        problems.push({
          code: "CRUD_COLLECTION_PROPERTY_TYPE_DIFFERS",
          message: `'schemas.${operation}' types '${name}' as ${own.join(" or ")}, and 'model' as ${read.join(" or ")}. One column has one type: declare the same one in both.`,
        });
      }
    }
  }
  for (const name of requiredOf(schemas.update)) {
    if (Object.hasOwn(readable, name) && !requiredOf(model).includes(name)) {
      problems.push({
        code: "CRUD_COLLECTION_UPDATE_REQUIRES_OPTIONAL",
        message: `'schemas.update' requires '${name}', which 'model' leaves optional, so a record read without it could not be sent back. Require it in 'model' too, or make it optional here.`,
      });
    }
  }
  return problems;
}

/**
 * What must hold of the table against `model` and the relations, each with the
 * sentence the static rule of the same name reports. A relation whose target's
 * table is not known (`undefined`) is not compared.
 */
export function tableProblems(
  model: JsonSchema,
  table: DeclaredTable,
  relations: Record<string, { key: string; table: string | undefined }>,
): Problem[] {
  const problems: Problem[] = [];
  const columns = new Map(rowColumns(table).map((column) => [column.name, column]));
  for (const name of Object.keys(propertiesOf(model))) {
    if (!columns.has(columnOf(name))) {
      problems.push({
        code: "CRUD_COLLECTION_PROPERTY_UNKNOWN_COLUMN",
        message: `'model' declares '${name}', and table '${table.name}' has no column '${columnOf(name)}'. A property is stored in the snake_case column of its name: add the column to the table, or remove the property.`,
      });
    }
  }
  if (columns.get(columnOf(KEY))?.primaryKey !== true) {
    problems.push({
      code: "CRUD_COLLECTION_TABLE_KEY_NOT_PRIMARY",
      message: `table '${table.name}' does not have '${KEY}' as its primary key. A record is addressed by '${KEY}': declare the column '${KEY}' with 'primaryKey: true'.`,
    });
  }
  for (const [property, target] of Object.entries(relations)) {
    if (target.table === undefined) continue;
    const column = columnOf(property);
    const keyColumn = columnOf(target.key);
    for (const foreignKey of table.foreignKeys) {
      const matches =
        foreignKey.references.table === target.table &&
        foreignKey.columns.every((name, index) => name !== column || foreignKey.references.columns[index] === keyColumn);
      if (foreignKey.columns.includes(column) && !matches) {
        const position = foreignKey.columns.indexOf(column);
        problems.push({
          code: "CRUD_COLLECTION_RELATION_FOREIGN_KEY_MISMATCH",
          message: `'relations.${property}' points at '${keyColumn}' of table '${target.table}', and foreign key '${foreignKey.name}' maps column '${column}' to '${foreignKey.references.columns[position]}' of table '${foreignKey.references.table}'. Make the foreign key reference the target's table and key column, or relate the property to the collection the foreign key names.`,
        });
      }
    }
  }
  return problems;
}

interface Read {
  declaration: CollectionDeclaration;
  schemas: Record<Operation, JsonSchema>;
}

/**
 * A collection served from one table: what `DataModel.Collection` declares, the
 * shapes of the three operations that are not a read, and the table the
 * records are stored in, read once and checked against each other before
 * anything is served from them.
 */
class Collection implements ResourceInstance {
  private read?: Read;

  constructor(
    private readonly resource: CollectionResource,
    private readonly ctx: ResourceContext,
  ) {}

  private declared(): Read {
    if (this.read) return this.read;
    const owner = `Crud.Collection '${this.resource.metadata.name}'`;
    const declaration = readCollection(this.resource, this.ctx, owner);
    const schemas = Object.fromEntries(
      OPERATIONS.map((operation) => [
        operation,
        modelSchema(this.resource.schemas?.[operation], this.ctx, owner, `schemas.${operation}`),
      ]),
    ) as Record<Operation, JsonSchema>;
    const table = this.ctx.resolveRef(this.resource.table, isDeclaredTable, () => `'table' of ${owner}`, "Sql.Table");
    const relations = Object.fromEntries(
      Object.entries(this.resource.relations ?? {}).map(([property, entry]) => [
        property,
        { key: declaration.relations[property].key, table: this.targetTable(entry.collection, owner) },
      ]),
    );
    const [problem] = [
      ...collectionProblems(declaration.model, declaration.key, declaration.query, declaration.relations),
      ...shapeProblems(declaration.model, schemas),
      ...tableProblems(declaration.model, table.declaration, relations),
    ];
    if (problem) throw new RuntimeError(`ERR_${problem.code}`, `${owner}: ${problem.message}`);
    return (this.read = { declaration, schemas });
  }

  /** The physical table of the collection a relation points at. */
  private targetTable(collection: unknown, owner: string): string | undefined {
    const lookup = this.ctx.resolveDeclaredManifest?.bind(this.ctx);
    if (!lookup) {
      throw new RuntimeError(
        "ERR_CONTROLLER_HOST_INCOMPATIBLE",
        `${owner}: this host cannot read declarations, which checking a relation against its foreign key needs.`,
      );
    }
    const read: TableNameRead = (name, alias, holder) => lookup(name, alias, holder);
    return targetTableName(collection, read);
  }

  init(): void {
    this.declared();
  }

  snapshot(): Record<string, unknown> {
    const { declaration, schemas } = this.declared();
    return {
      model: { schema: declaration.model },
      key: declaration.key,
      query: declaration.query,
      schemas: Object.fromEntries(OPERATIONS.map((operation) => [operation, { schema: schemas[operation] }])),
    };
  }
}

export async function create(resource: CollectionResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Collection(resource, ctx);
}
