/**
 * **Compile-eval results, held to their slots.**
 *
 * A value is validated while its expressions are still expressions, so each is
 * checked only as its schema's stand-in. The result is known once the value is
 * expanded, and it is held to the schema of the slot it fills here — the same
 * slot `telo check` types it against, found by the same union-aware walk. A
 * `dyn` expression passes the checker, and the value it produces must still be
 * what the slot declares; a sink's `when` that produces the string `"false"` is
 * refused rather than read as "not false".
 */
import { compiledResultSlots, formatSlotPath, type ExternalSchemaResolver } from "@telorun/analyzer";
import { detachSnapshotValue, isCompiledValue } from "@telorun/sdk";
import type { SchemaValidator } from "./schema-validator.js";

/** A slot's schema as a document of its own: wrapped, so the validator reads
 *  it as a whole schema however few keywords it has, with the `$defs` its
 *  references name taken from the document it was written in. Kept per slot so
 *  a repeat compile hits the cache. */
const standalone = new WeakMap<object, Record<string, any>>();

function standaloneSchema(schema: Record<string, any>, root: Record<string, any>): Record<string, any> {
  const cached = standalone.get(schema);
  if (cached) return cached;
  const built = {
    allOf: [schema],
    ...(root.$defs !== undefined ? { $defs: root.$defs } : {}),
    ...(root.definitions !== undefined ? { definitions: root.definitions } : {}),
  };
  standalone.set(schema, built);
  return built;
}

/**
 * Refuse the first expression result its slot's schema rejects. `refuse`
 * builds the error from the result's path and what was wrong with it, so each
 * caller keeps its own code (`ERR_MANIFEST_VALIDATION_FAILED` at load,
 * `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at creation).
 */
export function refuseMistypedResults(
  written: unknown,
  evaluated: unknown,
  schema: Record<string, any>,
  validator: SchemaValidator,
  refuse: (path: string, problem: string) => Error,
  options: { external?: ExternalSchemaResolver; root?: Record<string, any>; prefix?: string } = {},
): void {
  for (const slot of compiledResultSlots(
    written,
    evaluated,
    schema,
    isCompiledValue,
    options.external,
    options.root ?? schema,
  )) {
    if (slot.value === undefined) continue;
    const check = validator.compile(standaloneSchema(slot.schema, slot.root), { persist: false });
    // A detached copy: the validator fills schema defaults in place, and the
    // result may be an object other readers share (`variables.x`, a published
    // `resources.x`). The controller receives exactly what the expression made.
    if (check.isValid(detachSnapshotValue(slot.value))) continue;
    const path = [options.prefix, formatSlotPath(slot.segments)].filter(Boolean).join(".") || "/";
    throw refuse(
      path,
      `must be ${expectedOf(slot.schema)}, but the expression produced ${describeProduced(slot.value)}`,
    );
  }
}

function expectedOf(schema: Record<string, any>): string {
  const type = schema.type;
  if (typeof type === "string") return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
  if (Array.isArray(type)) return `one of ${type.join(" | ")}`;
  return "what its schema declares";
}

function describeProduced(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "bigint") return `the number ${String(value)}`;
  if (typeof value === "boolean") return `the boolean ${String(value)}`;
  if (Array.isArray(value)) return "a list";
  return "an object";
}
