/**
 * **`x-telo-schema-from` slots resolved to the schema each derives**, and the
 * refusals of those that name nothing — one of the site shapes `derived-slots.ts`
 * enumerates, kept apart because resolving an anchor is where its diagnostics
 * are worded. Browser-safe.
 */
import type { DerivedSlotContext } from "./derived-slots.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { resolveFieldEntries, resolveFieldValues } from "./reference-field-map.js";
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

/**
 * One `x-telo-schema-from` field of a resource, resolved per concrete value.
 *
 * Three anchor forms: an alias-qualified kind path resolved in the scope of the
 * kind that declared the slot; a sibling reference whose TARGET declares the
 * pointed field itself (the instance wins); and a sibling reference whose KIND
 * schema holds it.
 */
export function schemaFromSites(
  resource: Record<string, any>,
  fieldPath: string,
  schemaFrom: string,
  ctx: DerivedSlotContext,
): Array<SchemaFromSite | SchemaFromFailure> {
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
    for (const { value, path } of resolveFieldEntries(resource, fieldPath)) {
      if (value == null) continue;
      out.push({
        path,
        value,
        schema: subSchema as Record<string, any>,
        source: `${anchorName}${jsonPointer}`,
        form: "anchored",
      });
    }
    return out;
  }

  let anchorPath: string;
  if (isAbsolute) {
    anchorPath = anchorName;
  } else {
    const lastDot = fieldPath.lastIndexOf(".");
    anchorPath = lastDot === -1 ? anchorName : fieldPath.slice(0, lastDot + 1) + anchorName;
  }
  const anchorValues = resolveFieldValues(resource, anchorPath);
  if (anchorValues.length === 0) return out;
  const fieldEntries = resolveFieldEntries(resource, fieldPath);

  for (let i = 0; i < fieldEntries.length; i++) {
    const { value, path } = fieldEntries[i]!;
    if (value == null) continue;
    const anchorVal = isAbsolute ? anchorValues[0] : anchorValues[i];
    if (!anchorVal || typeof anchorVal !== "object") continue;
    const ref = anchorVal as Record<string, unknown>;
    if (typeof ref.kind !== "string") continue;

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
        continue;
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
      continue;
    }
    const subSchema = navigateJsonPointer(refDef.schema, jsonPointer);
    if (subSchema === undefined) {
      out.push({
        code: "SCHEMA_FROM_MISSING_PATH",
        message: `${label}: x-telo-schema-from at '${path}' → kind '${ref.kind}' has no schema path '${jsonPointer}'`,
        path,
      });
      continue;
    }
    out.push({
      path,
      value,
      schema: subSchema as Record<string, any>,
      source: `${ref.kind}${jsonPointer}`,
      form: "kind",
    });
  }
  return out;
}

/** True for a resolved schema-from site, false for a failure. */
export function isSchemaFromSite(
  entry: SchemaFromSite | SchemaFromFailure,
): entry is SchemaFromSite {
  return "schema" in entry;
}
