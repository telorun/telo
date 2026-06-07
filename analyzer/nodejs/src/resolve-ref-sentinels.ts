import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isRefEntry, isScopeEntry } from "./reference-field-map.js";
import { REF_RESOLUTION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

/** Resolved ref shape written in place of a `!ref` sentinel. `alias` is set only for
 *  cross-module references (resolved into an imported library's exported instance). */
type ResolvedRef = { kind: string; name: string; alias?: string };

/**
 * Walks every `x-telo-ref` slot in every non-system resource and rewrites
 * `!ref <name>` sentinels in-place to `{kind, name}` (local) or
 * `{kind, name, alias}` (cross-module).
 *
 * Reference grammar — the tag's source string is split on the FIRST dot:
 *   - `!ref writeLine`          → local resource `writeLine`
 *   - `!ref Self.writeLine`     → local resource `writeLine` (explicit self-qualifier)
 *   - `!ref Console.writeLine`  → instance `writeLine` exported by the import aliased
 *                                 `Console`, resolved against the forwarded foreign set
 *
 * Aliases are PascalCase identifiers without dots and resource names carry no dots
 * (enforced as a hard diagnostic), so the first-dot split is unambiguous. When the
 * name doesn't resolve, the sentinel is left in place so `validateReferences` emits the
 * `UNRESOLVED_REFERENCE` diagnostic with full context.
 *
 * Forwarded foreign resources (an imported library's exported instances, carrying a
 * `metadata.module` that isn't a root module) are resolution TARGETS only — they are not
 * re-walked as sources here, since their own ref slots belong to their own module scope.
 */
export function resolveRefSentinels(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  // Extra foreign resources used only as cross-module resolution TARGETS (not mutated, not
  // walked as sources). The kernel passes the analyzer-flattened set here so the runtime
  // pass — which loads the entry module only — can still resolve `!ref Alias.name` against
  // imported libraries' exported instances.
  crossModuleTargets: ResourceManifest[] = [],
): void {
  const moduleOf = (r: ResourceManifest): string | undefined =>
    (r.metadata as { module?: string } | undefined)?.module;
  // Forwarded exports are flagged by flattenForAnalyzer (`metadata.forwardedExport`); they're
  // cross-module resolution targets only — never walked as local ref sources here.
  const isForeign = (r: ResourceManifest): boolean =>
    (r.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true;

  // Local resources resolve a bare / `Self.`-qualified name; forwarded foreign exports
  // resolve an `Alias.`-qualified name keyed by (module, name).
  const byName = new Map<string, ResourceManifest>();
  const byModuleName = new Map<string, ResourceManifest>();
  for (const r of resources) {
    if (!r.metadata?.name || SYSTEM_KINDS.has(r.kind)) continue;
    const name = r.metadata.name as string;
    if (isForeign(r)) {
      byModuleName.set(`${moduleOf(r)}\0${name}`, r);
    } else {
      byName.set(name, r);
    }
  }
  for (const r of crossModuleTargets) {
    if (!r.metadata?.name || SYSTEM_KINDS.has(r.kind) || !isForeign(r)) continue;
    byModuleName.set(`${moduleOf(r)}\0${r.metadata.name as string}`, r);
  }

  const resolveTarget = (source: string): ResolvedRef | undefined => {
    const dot = source.indexOf(".");
    if (dot === -1) {
      const t = byName.get(source);
      return t ? { kind: t.kind as string, name: source } : undefined;
    }
    const alias = source.slice(0, dot);
    const name = source.slice(dot + 1);
    if (alias === "Self") {
      const t = byName.get(name);
      return t ? { kind: t.kind as string, name } : undefined;
    }
    const module = aliases?.moduleForAlias(alias);
    if (module) {
      const t = byModuleName.get(`${module}\0${name}`);
      if (t) {
        // The foreign instance's `kind` is authored in ITS module's scope (e.g.
        // `Self.WriteLine`); canonicalize to a scope-independent `<module>.<Kind>` for the
        // consumer's kind check. `Self.` maps to the owning module directly — the forwarded
        // library's Library doc (hence its `Self` alias) isn't in the consumer's manifest
        // set — while other alias prefixes resolve via that module's forwarded import scope.
        const rawKind = t.kind as string;
        const foreignKind = rawKind.startsWith("Self.")
          ? `${module}.${rawKind.slice("Self.".length)}`
          : aliasesByModule?.get(module)?.resolveKind(rawKind) ?? rawKind;
        return { kind: foreignKind, name, alias };
      }
    }
    return undefined;
  };

  const processResource = (r: ResourceManifest): void => {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) return;

    const fieldMap =
      aliases && aliasesByModule
        ? registry.expandedFieldMapForResource(r, aliases, aliasesByModule)
        : registry.getFieldMapForKind(r.kind, aliases);
    if (!fieldMap) return;

    for (const [fieldPath, entry] of fieldMap) {
      const parts = fieldPath.split(".");
      if (isRefEntry(entry)) {
        descend(r as Record<string, unknown>, parts, resolveTarget);
      } else if (isScopeEntry(entry)) {
        // x-telo-scope resources (e.g. a Run.Sequence `with` server) carry their own ref
        // slots. The top-level walk skips scope contents, so recurse so a scoped resource's
        // `!ref` (e.g. an Http.Server mount) is canonicalized to {kind, name} like any other.
        forEachScopeResource(r as Record<string, unknown>, parts, processResource);
      }
    }
  };

  for (const r of resources) {
    if (isForeign(r)) continue;
    processResource(r);
  }
}

/**
 * Navigates `obj` along the scope field path (dot notation, `[]` = array items) and
 * invokes `cb` on every resource-like object found — any value carrying a `kind` string.
 *
 * Two-phase design:
 *
 *  Phase 1 — path-walk: steps through each `parts` segment. `[]`-suffixed parts spread
 *  the array into individual elements so `current` always ends up holding scalars or
 *  plain objects, never intermediate arrays. Non-`[]` parts push the value as-is.
 *
 *  Phase 2 — terminal visit: after the walk, `current` contains the values at the end
 *  of the path. These are always scalars or plain objects because of the `[]` spreading
 *  above, EXCEPT when a scope field is typed as an array in the schema but the path
 *  was authored WITHOUT a `[]` suffix. The `visit` function handles that case by
 *  recursing one level into arrays so `cb` is always called on resource objects, not
 *  on their container.
 */
function forEachScopeResource(
  obj: Record<string, unknown>,
  parts: string[],
  cb: (resource: ResourceManifest) => void,
): void {
  let current: unknown[] = [obj];
  for (const part of parts) {
    const isArr = part.endsWith("[]");
    const key = isArr ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const node of current) {
      if (!node || typeof node !== "object") continue;
      const val = (node as Record<string, unknown>)[key];
      if (val == null) continue;
      if (isArr && Array.isArray(val)) next.push(...val);
      else if (!isArr) next.push(val);
    }
    current = next;
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const elem of node) visit(elem);
    } else if (node && typeof node === "object" && typeof (node as { kind?: unknown }).kind === "string") {
      cb(node as ResourceManifest);
    }
  };
  for (const node of current) visit(node);
}

/** Walks `obj` along `fieldPath` parts (dot notation with `[]` for arrays and `{}` for
 *  additionalProperties-typed maps) and replaces any `!ref` sentinel at the terminal slot
 *  with its resolved `{kind, name, alias?}`. Mutates the parent container in place. */
function descend(
  obj: unknown,
  parts: string[],
  resolve: (source: string) => ResolvedRef | undefined,
): void {
  if (obj == null || typeof obj !== "object" || parts.length === 0) return;
  const [head, ...rest] = parts;

  if (head === "{}") {
    const container = obj as Record<string, unknown>;
    for (const key of Object.keys(container)) {
      const child = container[key];
      if (rest.length === 0) {
        if (isRefSentinel(child)) {
          const target = resolve(child.source);
          if (target) container[key] = target;
        }
      } else {
        descend(child, rest, resolve);
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
          const target = resolve(elem.source);
          if (target) val[i] = target;
        }
      } else {
        descend(val[i], rest, resolve);
      }
    }
  } else {
    if (rest.length === 0) {
      if (isRefSentinel(val)) {
        const target = resolve(val.source);
        if (target) container[key] = target;
      }
    } else {
      descend(val, rest, resolve);
    }
  }
}
