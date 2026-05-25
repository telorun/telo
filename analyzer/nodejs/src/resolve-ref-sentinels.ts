import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isRefEntry } from "./reference-field-map.js";
import { REF_RESOLUTION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

/**
 * Walks every `x-telo-ref` slot in every non-system resource and rewrites
 * `!ref <name>` sentinels in-place to `{kind: <resolved-kind>, name}`.
 *
 * The downstream pipeline (inline normalization, dependency graph, kernel
 * controllers) expects every ref-slot value to be either a `{kind, name}`
 * object, an inline-definition object, or a legacy bare string — resolving
 * sentinels here keeps that contract intact so each consumer doesn't need
 * its own sentinel branch.
 *
 * The walker assigns `kind` by name lookup (resource names are unique
 * within a manifest scope). When the name doesn't resolve in the local
 * `byName` map, the sentinel is left in place so `validateReferences`
 * can emit the `UNRESOLVED_REFERENCE` diagnostic with full context.
 *
 * Mutation strategy: the field-path walker descends the resource tree
 * directly and replaces the sentinel on its parent container. Re-parsing
 * a string-encoded concrete path (the earlier shape) coupled the writer
 * to the path-encoding rules of `resolveFieldEntries` — any new path
 * marker would silently break this writer. Descending directly avoids
 * that coupling.
 */
export function resolveRefSentinels(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): void {
  const byName = new Map<string, ResourceManifest>();
  for (const r of resources) {
    if (r.metadata?.name && !SYSTEM_KINDS.has(r.kind)) {
      byName.set(r.metadata.name as string, r);
    }
  }

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    const fieldMap =
      aliases && aliasesByModule
        ? registry.expandedFieldMapForResource(r, aliases, aliasesByModule)
        : registry.getFieldMapForKind(r.kind, aliases);
    if (!fieldMap) continue;

    for (const [fieldPath, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;
      replaceSentinelsAtPath(r as Record<string, unknown>, fieldPath, byName);
    }
  }
}

/** Walks `obj` along `fieldPath` (dot notation with `[]` for arrays and
 *  `{}` for additionalProperties-typed maps) and replaces any `!ref`
 *  sentinel value at the terminal slot with `{kind, name}` looked up
 *  via `byName`. Mutates the parent container in place; no string-path
 *  round-trip. */
function replaceSentinelsAtPath(
  obj: Record<string, unknown>,
  fieldPath: string,
  byName: Map<string, ResourceManifest>,
): void {
  const parts = fieldPath.split(".");
  descend(obj, parts, byName);
}

function descend(
  obj: unknown,
  parts: string[],
  byName: Map<string, ResourceManifest>,
): void {
  if (obj == null || typeof obj !== "object" || parts.length === 0) return;
  const [head, ...rest] = parts;

  // Map iteration: descend into every value of the current object.
  if (head === "{}") {
    const container = obj as Record<string, unknown>;
    for (const key of Object.keys(container)) {
      const child = container[key];
      if (rest.length === 0) {
        if (isRefSentinel(child)) {
          const target = byName.get(child.source);
          if (target) container[key] = { kind: target.kind as string, name: child.source };
        }
      } else {
        descend(child, rest, byName);
      }
    }
    return;
  }

  const isArr = head.endsWith("[]");
  const key = isArr ? head.slice(0, -2) : head;
  const container = obj as Record<string, unknown>;
  const val = container[key];
  if (val == null) return;

  if (isArr) {
    if (!Array.isArray(val)) return;
    for (let i = 0; i < val.length; i++) {
      if (rest.length === 0) {
        const elem = val[i];
        if (isRefSentinel(elem)) {
          const target = byName.get(elem.source);
          if (target) val[i] = { kind: target.kind as string, name: elem.source };
        }
      } else {
        descend(val[i], rest, byName);
      }
    }
  } else {
    if (rest.length === 0) {
      if (isRefSentinel(val)) {
        const target = byName.get(val.source);
        if (target) container[key] = { kind: target.kind as string, name: val.source };
      }
    } else {
      descend(val, rest, byName);
    }
  }
}
