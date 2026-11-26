import { authoredSchemaRef, type ExternalSchemaResolver, type OwnValuePositions } from "@telorun/analyzer";
import { parseCanonicalTypeSchemaId, RuntimeError, type DataValidator } from "@telorun/sdk";
import { SchemaValidator } from "./schema-validator.js";

/**
 * Makes every named shape a module document's `variables:` / `secrets:` entries
 * reference by canonical id known to `validator`, so an input is validated
 * against the shape its entry names before any resource — the shape's own
 * included — is created: an Application's when its inputs are read. A shape's
 * own references are followed.
 */
export function registerModuleInputShapes(
  moduleDoc: Record<string, unknown> | undefined,
  validator: Pick<SchemaValidator, "getSchema" | "addSchema">,
  shapeOf: (id: string) => Record<string, any> | undefined,
): void {
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const ref = (node as { $ref?: unknown }).$ref;
    const id = typeof ref === "string" ? ref.split("#")[0]! : undefined;
    if (id && parseCanonicalTypeSchemaId(id) && !validator.getSchema(id)) {
      const shape = shapeOf(id);
      if (shape) {
        validator.addSchema(id, shape);
        visit(shape);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  for (const block of ["variables", "secrets"]) visit(moduleDoc?.[block]);
}

/** How an import validates and binds its library's entries. */
export interface ImportInputShapes {
  /** A validator for one schema node over the entries, `ownValues` the values
   *  it holds that are validated on their own. */
  compile(schema: Record<string, any>, ownValues?: OwnValuePositions): DataValidator;
  /** A canonical shape reference, for the decode, build and normalize walks. */
  readonly resolve: ExternalSchemaResolver;
  /** Refuses an entry `supplied` holds a value for whose type names a shape
   *  this import's configuration does not declare. */
  refuseUnresolved(block: "variables" | "secrets", supplied: Record<string, unknown>): void;
}

/** What validates a set of shapes for the imports whose configuration reads
 *  them so: a validator holding exactly those, kept by the caller. */
export type IsolatedValidators = (shapes: ReadonlyMap<string, Record<string, any>>) => SchemaValidator;

const DATA_KEYS = new Set(["default", "const", "enum", "examples"]);

/**
 * The named shapes a library's entries reach, each read off the configuration
 * view of one import (`shapeOf`). A shape no configuration varies is answered
 * by the shared registry (`shared`) and registered in the kernel's validator
 * (`kernel`), first wins; when any shape reached is one the configuration answers from its
 * own expansion, the entries are validated by a validator holding this
 * configuration's shapes alone — one id may hold another content for another
 * import of the library in this process.
 */
export function importInputShapes(
  declared: { readonly variables: Record<string, unknown>; readonly secrets: Record<string, unknown> },
  /** The library document's blocks as written, which a refusal quotes. */
  written: { readonly variables?: unknown; readonly secrets?: unknown },
  alias: string,
  shapeOf: (id: string) => Record<string, any> | undefined,
  shared: (id: string) => Record<string, any> | undefined,
  kernel: {
    readonly registered: Pick<SchemaValidator, "getSchema" | "addSchema">;
    compile(schema: Record<string, any>, ownValues?: OwnValuePositions): DataValidator;
  },
  isolated: IsolatedValidators,
): ImportInputShapes {
  const reached = new Map<string, Record<string, any>>();
  const unresolved = new Map<string, { ref: string; id: string }>();
  /** `authored` is the node at the same place as written, while the walk is
   *  inside the entry rather than a shape it reached. */
  const visit = (node: unknown, authored: unknown, missing: (ref: string, id: string) => void): void => {
    if (node === null || typeof node !== "object") return;
    const at = (key: string | number) =>
      authored !== null && typeof authored === "object" ? (authored as Record<string | number, unknown>)[key] : undefined;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, at(index), missing));
      return;
    }
    const ref = (node as { $ref?: unknown }).$ref;
    const id = typeof ref === "string" ? ref.split("#")[0]! : undefined;
    if (id && parseCanonicalTypeSchemaId(id) && !reached.has(id)) {
      const shape = shapeOf(id);
      if (shape) {
        reached.set(id, shape);
        visit(shape, undefined, missing);
      } else {
        const writtenRef = at("$ref");
        missing(authoredSchemaRef(node) ?? (typeof writtenRef === "string" ? writtenRef : (ref as string)), id);
      }
    }
    for (const [key, value] of Object.entries(node)) if (!DATA_KEYS.has(key)) visit(value, at(key), missing);
  };
  for (const block of ["variables", "secrets"] as const) {
    const writtenBlock = written[block] as Record<string, unknown> | undefined;
    for (const [name, entry] of Object.entries(declared[block])) {
      visit(entry, writtenBlock?.[name], (ref, id) => {
        if (!unresolved.has(`${block}.${name}`)) unresolved.set(`${block}.${name}`, { ref, id });
      });
    }
  }
  const refuseUnresolved = (block: "variables" | "secrets", supplied: Record<string, unknown>) => {
    for (const name of Object.keys(declared[block])) {
      const missing = supplied[name] === undefined ? undefined : unresolved.get(`${block}.${name}`);
      if (!missing) continue;
      const named = parseCanonicalTypeSchemaId(missing.id)!;
      throw new RuntimeError(
        "ERR_SCHEMA_TYPE_REF_UNRESOLVED",
        `Import '${alias}': ${block}.${name}: schema $ref '${missing.ref}' resolves to module ` +
          `'${named.moduleName}', which declares no Telo.Type named '${named.typeName}' in the ` +
          `configuration this import runs in.`,
      );
    }
  };
  const varies = [...reached.keys()].some((id) => shared(id) === undefined);
  if (!varies) {
    for (const [id, shape] of reached) if (!kernel.registered.getSchema(id)) kernel.registered.addSchema(id, shape);
    return {
      compile: (schema, ownValues) => kernel.compile(schema, ownValues),
      resolve: shapeOf,
      refuseUnresolved,
    };
  }
  const validator = isolated(reached);
  return {
    compile: (schema, ownValues) => validator.compile(schema, { persist: false, ownValues }),
    resolve: (id) => reached.get(id) ?? shapeOf(id),
    refuseUnresolved,
  };
}
