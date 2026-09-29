/**
 * **`x-telo-schema-from` slots resolved to the schema each derives**, and the
 * refusals of those that name nothing — one of the site shapes `derived-slots.ts`
 * enumerates, kept apart because resolving an anchor is where its diagnostics
 * are worded. Browser-safe.
 */
import type { DerivedSlotContext } from "./derived-slots.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { navigateJsonPointer } from "./schema-compat.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

/** An `x-telo-schema-from` slot resolved to the schema it derives. */
export interface SchemaFromSite {
  readonly path: string;
  readonly value: unknown;
  readonly schema: Record<string, any>;
  /** Names where the schema came from, for a message. */
  readonly source: string;
  /** `anchored` / `kind` report issues inside the value; `instance` at the slot. */
  readonly form: "anchored" | "instance" | "kind";
}

/** An `x-telo-schema-from` slot that could not be resolved. */
export interface SchemaFromFailure {
  readonly code: "INVALID_SCHEMA_FROM" | "SCHEMA_FROM_MISSING_PATH";
  readonly message: string;
  readonly path: string;
}

/** One concrete `x-telo-schema-from` site of a resource, as the reach found it. */
export interface SchemaFromSlotSite {
  /** The declared pattern, for a message about the slot itself. */
  readonly fieldPath: string;
  /** The concrete path and the value written there. */
  readonly path: string;
  readonly value: unknown;
  /** The object holding the value — where a relative anchor's sibling lives. */
  readonly holder?: Record<string, unknown> | unknown[];
}

/**
 * True when every failure an `x-telo-schema-from` expression can raise is
 * decided by the kind alone — a malformed expression, or an alias-qualified
 * anchor (`HttpDispatch.Outcomes/$defs/Returns`) — rather than by what a
 * resource writes at a sibling anchor.
 */
export function schemaFromIsKindDecidable(schemaFrom: string): boolean {
  const expr = schemaFrom.startsWith("/") ? schemaFrom.slice(1) : schemaFrom;
  const slash = expr.indexOf("/");
  return slash === -1 || (!schemaFrom.startsWith("/") && expr.slice(0, slash).includes("."));
}

/**
 * One `x-telo-schema-from` site of a resource, resolved.
 *
 * Three anchor forms: an alias-qualified kind path resolved in the scope of the
 * kind that declared the slot; a sibling reference whose TARGET declares the
 * pointed field itself (the instance wins); and a sibling reference whose KIND
 * schema holds it. A relative anchor names a sibling of the slot, an absolute
 * one a top-level field of the resource.
 */
export function schemaFromSites(
  resource: Record<string, any>,
  slot: SchemaFromSlotSite,
  schemaFrom: string,
  ctx: DerivedSlotContext,
): Array<SchemaFromSite | SchemaFromFailure> {
  const { fieldPath } = slot;
  const out: Array<SchemaFromSite | SchemaFromFailure> = [];
  const label = `${resource.kind}/${resource.metadata?.name as string}`;
  const isAbsolute = schemaFrom.startsWith("/");
  const expr = isAbsolute ? schemaFrom.slice(1) : schemaFrom;
  const slashIdx = expr.indexOf("/");
  if (slashIdx === -1) {
    out.push({
      code: "INVALID_SCHEMA_FROM",
      message: `${label}: x-telo-schema-from "${schemaFrom}" must contain at least one "/" to separate anchor from JSON Pointer`,
      path: fieldPath,
    });
    return out;
  }
  const anchorName = expr.slice(0, slashIdx);
  const jsonPointer = "/" + expr.slice(slashIdx + 1);

  // Relative anchors are property names that cannot contain a dot, so a dot
  // marks an alias-qualified kind path.
  if (!isAbsolute && anchorName.includes(".")) {
    const resolvedResourceKind = ctx.aliases.resolveKind(resource.kind) ?? resource.kind;
    const resourceDef = ctx.defs.resolve(resource.kind) ?? ctx.defs.resolve(resolvedResourceKind);
    const ownerScope = moduleAliasScope(resourceDef?.metadata, ctx.aliases, ctx.aliasesByModule);
    const targetKind = ownerScope.resolveKind(anchorName);
    if (!targetKind) {
      const aliasName = anchorName.slice(0, anchorName.indexOf("."));
      out.push({
        code: "SCHEMA_FROM_MISSING_PATH",
        message:
          `${label}: x-telo-schema-from at '${fieldPath}' → cannot resolve alias ` +
          `'${aliasName}' (in '${anchorName}'). Check the import that declares it.`,
        path: fieldPath,
      });
      return out;
    }
    const targetDef = ctx.defs.resolve(targetKind);
    if (!targetDef?.schema) {
      out.push({
        code: "SCHEMA_FROM_MISSING_PATH",
        message: `${label}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema`,
        path: fieldPath,
      });
      return out;
    }
    const subSchema = navigateJsonPointer(targetDef.schema, jsonPointer);
    if (subSchema === undefined) {
      out.push({
        code: "SCHEMA_FROM_MISSING_PATH",
        message: `${label}: x-telo-schema-from at '${fieldPath}' → kind '${targetKind}' has no schema path '${jsonPointer}'`,
        path: fieldPath,
      });
      return out;
    }
    if (slot.value == null) return out;
    out.push({
      path: slot.path,
      value: slot.value,
      schema: subSchema as Record<string, any>,
      source: `${anchorName}${jsonPointer}`,
      form: "anchored",
    });
    return out;
  }

  const { value, path } = slot;
  if (value == null) return out;
  const enclosing = isAbsolute
    ? resource
    : slot.holder && !Array.isArray(slot.holder)
      ? slot.holder
      : undefined;
  const anchorVal = enclosing?.[anchorName];
  if (!anchorVal || typeof anchorVal !== "object") return out;
  const ref = anchorVal as Record<string, unknown>;
  if (typeof ref.kind !== "string") return out;
  // The instance first, then the kind: a kind whose shape is per instance
  // declares it as a field, and reading only the definition types every
  // instance against nothing.
  const target =
    typeof ref.name === "string" ? ctx.resolveTarget(ref as Record<string, any>) : undefined;
  const perInstance =
    target === undefined
      ? undefined
      : navigateJsonPointer(target as Record<string, unknown>, jsonPointer);
  if (perInstance !== undefined) {
    const instanceSchema = resolveTypeFieldToSchema(perInstance, ctx.typeManifests);
    if (instanceSchema) {
      out.push({
        path,
        value,
        schema: instanceSchema,
        source: `the schema '${ref.name as string}' declares at '${jsonPointer}'`,
        form: "instance",
      });
      return out;
    }
  }

  const refResolvedKind = ctx.aliases.resolveKind(ref.kind) ?? ref.kind;
  const refDef = ctx.defs.resolve(ref.kind) ?? ctx.defs.resolve(refResolvedKind);
  if (!refDef?.schema) {
    out.push({
      code: "SCHEMA_FROM_MISSING_PATH",
      message: `${label}: x-telo-schema-from at '${path}' → kind '${ref.kind}' has no schema`,
      path,
    });
    return out;
  }
  const subSchema = navigateJsonPointer(refDef.schema, jsonPointer);
  if (subSchema === undefined) {
    out.push({
      code: "SCHEMA_FROM_MISSING_PATH",
      message: `${label}: x-telo-schema-from at '${path}' → kind '${ref.kind}' has no schema path '${jsonPointer}'`,
      path,
    });
    return out;
  }
  out.push({
    path,
    value,
    schema: subSchema as Record<string, any>,
    source: `${ref.kind}${jsonPointer}`,
    form: "kind",
  });
  return out;
}

/** True for a resolved schema-from site, false for a failure. */
export function isSchemaFromSite(
  entry: SchemaFromSite | SchemaFromFailure,
): entry is SchemaFromSite {
  return "schema" in entry;
}
