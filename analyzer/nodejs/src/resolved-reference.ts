/**
 * What a value at a reference slot IS: a resolved reference or an inline
 * declaration. The one reader every inline-versus-reference decision goes
 * through, in the analyzer and — re-imported — in the kernel.
 *
 * A resolved reference carries the marker `__ref: true`, written by whatever
 * produced it (`!ref` resolution, inline extraction, a template body's `!ref`,
 * a step target's normalization). Every other plain object with a string
 * `kind` is an inline declaration, whatever else it holds: a `name` decides
 * nothing, so a kind may declare a configuration field called `name` and be
 * declared inline like any other. The Rust half writes and reads the same
 * marker (`analyzer/rust/src/resolved_reference.rs`).
 */
import type { ResourceDefinition } from "@telorun/sdk";
import { effectiveAuthorSchema, type DefResolver } from "./extends-resolution.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";

/** The key a resolved reference is marked with. An author never writes it. */
export const RESOLVED_REFERENCE_MARKER = "__ref";

/** A reference resolved to the declaration it names. `alias` is set only for a
 *  cross-module reference into an imported library's exported instance. */
export interface ResolvedReference {
  __ref: true;
  kind: string;
  name: string;
  alias?: string;
}

/** The resolved reference to `name` (of `kind`), reached through `alias` when
 *  it crosses an import. */
export function resolvedReference(kind: string, name: string, alias?: string): ResolvedReference {
  return alias === undefined ? { __ref: true, kind, name } : { __ref: true, kind, name, alias };
}

/** Plain data — what a manifest holds. A live instance a slot holds after
 *  injection is never one of these shapes. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** True when `value` is a resolved reference — read off the marker alone. */
export function isResolvedReference(value: unknown): value is ResolvedReference {
  return (
    isPlainObject(value) &&
    value[RESOLVED_REFERENCE_MARKER] === true &&
    typeof value.kind === "string" &&
    typeof value.name === "string"
  );
}

/** True when `value` is an inline declaration: a plain object with a string
 *  `kind` that is not a resolved reference. */
export function isInlineDeclaration(value: unknown): value is Record<string, unknown> & { kind: string } {
  return isPlainObject(value) && typeof value.kind === "string" && value[RESOLVED_REFERENCE_MARKER] !== true;
}

/**
 * True when `value` is the legacy `{ kind, name }` reference form: a plain
 * object holding a string `kind` and a string `name`, no marker key, whose kind
 * declares no top-level `name` field (`kindDeclaresName` answers `false`; a
 * kind that does not resolve answers `undefined` and is no evidence either
 * way). Published artifacts carry it, so normalization reads it as the
 * reference it means ({@link asResolvedReference}); the entry's own modules
 * are refused for writing it (`INVALID_REFERENCE_FORM`).
 */
export function isLegacyReferenceForm(
  value: unknown,
  kindDeclaresName: (kind: string) => boolean | undefined,
): value is Record<string, unknown> & { kind: string; name: string } {
  return (
    isPlainObject(value) &&
    !Object.prototype.hasOwnProperty.call(value, RESOLVED_REFERENCE_MARKER) &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    kindDeclaresName(value.kind) === false
  );
}

/** A legacy `{ kind, name }` object marked as the resolved reference it means,
 *  every other key it holds kept. */
export function asResolvedReference(
  value: Record<string, unknown> & { kind: string; name: string },
): ResolvedReference {
  return { [RESOLVED_REFERENCE_MARKER]: true, ...value } as unknown as ResolvedReference;
}

/** True when an author wrote the marker key themselves — refused, since only
 *  resolution may produce a resolved reference. */
export function carriesReferenceMarker(value: unknown): boolean {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, RESOLVED_REFERENCE_MARKER);
}

/**
 * True when the kind declares a top-level `name` property in its author schema
 * — the schema an instance is written against, folded along `extends` exactly
 * as the kernel stamps it at registration (`base:` children their own schema
 * only, every other child `merge(parent, own)`). The root's own `properties`
 * count, and so do those of every node the root is through a local `$ref`, an
 * `allOf` conjunct or a union branch, as `gatherPropertySchemas` reads them.
 *
 * What it decides is which spelling an object holding a `name` is: for a kind
 * declaring none it is the legacy `{ kind, name }` reference form — refused as
 * `INVALID_REFERENCE_FORM` in the entry's own modules, read as the reference it
 * meant in a dependency's — and for a kind declaring one it is an inline
 * declaration.
 */
export function declaresNameField(
  definition: ResourceDefinition | undefined,
  resolve: DefResolver,
): boolean {
  if (!definition) return false;
  return schemaDeclaresTopLevel(effectiveAuthorSchema(definition, resolve), "name");
}

/** Whether `schema` declares the property `key` at its root, through local
 *  references, `allOf` conjuncts and `anyOf` / `oneOf` branches. */
function schemaDeclaresTopLevel(schema: unknown, key: string): boolean {
  if (!isPlainObject(schema)) return false;
  const root = schema;
  const seen = new Set<object>();
  const declares = (node: unknown): boolean => {
    if (!isPlainObject(node) || seen.has(node)) return false;
    seen.add(node);
    if (isPlainObject(node.properties) && Object.prototype.hasOwnProperty.call(node.properties, key)) {
      return true;
    }
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith("#") && declares(resolveSchemaPointer(root, ref))) return true;
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches) && branches.some(declares)) return true;
    }
    return false;
  };
  return declares(schema);
}
