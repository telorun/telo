import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import {
  isScopeEntry,
  resolveFieldEntries,
  type ReferenceFieldMap,
} from "./reference-field-map.js";
import { REF_RESOLUTION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

/** The slice of the definition registry this pass needs: a kind's field map, from
 *  which the `x-telo-scope` slots are read. */
export interface ScopeFieldMapSource {
  getFieldMapForKind(
    kind: string,
    aliases?: { resolveKind(k: string): string | undefined },
  ): ReferenceFieldMap | undefined;
}

/** Resolved ref shape written in place of a `!ref` sentinel. `alias` is set only for
 *  cross-module references (resolved into an imported library's exported instance). */
type ResolvedRef = { kind: string; name: string; alias?: string };

/**
 * Rewrites every `!ref <name>` sentinel in each non-system resource's value tree
 * to `{kind, name}` (local) or `{kind, name, alias}` (cross-module), in place.
 *
 * The walk is value-tree-driven, not field-map-driven: a `!ref` tag is an
 * *explicit* reference marker, so any sentinel found anywhere is unambiguously a
 * reference and is resolved. This reaches sites the field map intentionally does
 * not descend — notably `Run.Sequence` step `invoke`s (behind a local `$ref`)
 * and references nested inside inline definitions — so every downstream consumer
 * (Phase-5 injection, the runtime controllers, the analyzer's step-context and
 * dependency passes) sees the uniform `{kind, name}` shape regardless of where
 * the reference was written.
 *
 * Resolving a sentinel here does NOT cause Phase-5 injection: that pass is
 * driven by the field map, which still excludes step `invoke`s, so a resolved
 * step invoke stays `{kind, name}` and is dispatched through
 * `executeInvokeStep` (preserving `<name>.Invoked` events) rather than
 * being replaced with a live instance.
 *
 * Reference grammar — the tag's source string is split on the FIRST dot:
 *   - `!ref writeLine`          → local resource `writeLine`
 *   - `!ref Self.writeLine`     → local resource `writeLine` (explicit self-qualifier)
 *   - `!ref Console.writeLine`  → instance `writeLine` exported by the import aliased
 *                                 `Console`, resolved against the forwarded foreign set
 *
 * Aliases are PascalCase identifiers without dots and resource names carry no dots
 * (enforced as a hard diagnostic), so the first-dot split is unambiguous. When the
 * name doesn't resolve (e.g. a scope-local target, or a cross-module reference in
 * partial single-file analysis), the sentinel is left in place — the runtime
 * resolves scope-local names on demand, and `validateReferences` emits the
 * `UNRESOLVED_REFERENCE` diagnostic for genuine misses.
 *
 * Forwarded foreign resources (an imported library's exported instances, carrying a
 * `metadata.module` that isn't a root module) are resolution TARGETS only — they are not
 * re-walked as sources here, since their own ref slots belong to their own module scope.
 */
export function resolveRefSentinels(
  resources: ResourceManifest[],
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  // Extra foreign resources used only as cross-module resolution TARGETS (not mutated, not
  // walked as sources). The kernel passes the analyzer-flattened set here so the runtime
  // pass — which loads the entry module only — can still resolve `!ref Alias.name` against
  // imported libraries' exported instances.
  crossModuleTargets: ResourceManifest[] = [],
  /** Supplies each kind's `x-telo-scope` slots. Without it a scoped name cannot be
   *  told from a module-level one, and a shadowed `!ref` resolves to the resource
   *  it shadows — so both call sites pass it. */
  defs?: ScopeFieldMapSource,
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

  /** Names a resource declares in its own execution scopes, read from the kind's
   *  `x-telo-scope` slots — the analyzer's single definition of "scope", shared
   *  with `manifest-visitor`. Inferring it structurally instead (any array of
   *  named inline manifests) would give scope-local shadowing to the first kind
   *  that happens to carry such an array without asking for it, and this pass is
   *  shared with the kernel, so the guess would be baked into the runtime tree
   *  rather than merely reported. */
  const declaredInScopes = (
    resource: ResourceManifest,
  ): Map<string, ResourceManifest> | undefined => {
    const fieldMap = defs?.getFieldMapForKind(resource.kind, aliases);
    if (!fieldMap) return undefined;
    let declared: Map<string, ResourceManifest> | undefined;
    for (const [fieldPath, entry] of fieldMap) {
      if (!isScopeEntry(entry)) continue;
      for (const { value } of resolveFieldEntries(resource, fieldPath)) {
        for (const element of Array.isArray(value) ? value : [value]) {
          if (!element || typeof element !== "object" || Array.isArray(element)) continue;
          const manifest = element as ResourceManifest;
          const name = (manifest.metadata as { name?: string } | undefined)?.name;
          if (typeof manifest.kind === "string" && typeof name === "string") {
            (declared ??= new Map()).set(name, manifest);
          }
        }
      }
    }
    return declared;
  };

  // Resolve every `!ref` sentinel in the tree; leave opaque tagged / precompiled
  // nodes (e.g. `!cel`) untouched and don't descend into them.
  //
  // `scoped` carries the names the enclosing resource declares in its `x-telo-scope`
  // slots, and they SHADOW the module-level ones — the order the runtime resolves
  // in. Baking the module-level kind into a shadowed reference would label traces
  // and `getRefIdentity` with a resource that never runs.
  const walk = (value: unknown, scoped?: Map<string, ResourceManifest>): unknown => {
    if (isRefSentinel(value)) {
      const source = value.source;
      const bare = source.indexOf(".") === -1;
      const shadow = bare ? scoped?.get(source) : undefined;
      if (shadow) return { kind: shadow.kind as string, name: source };
      return resolveTarget(source) ?? value;
    }
    if (value === null || typeof value !== "object") return value;
    if (isTaggedSentinel(value)) return value;
    if ((value as { __compiled?: unknown }).__compiled) return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i], scoped);
      return value;
    }
    const obj = value as Record<string, unknown>;
    // A nested inline resource may declare scopes of its own (a `Run.Sequence`
    // inside another sequence's `with:`). Collected before descending, so the
    // declarations are visible to every region of the resource that declares
    // them — a sequence's `with:` names resolve in its `targets:` and `steps:`
    // alike, not only inside `with:` itself.
    const declared =
      typeof obj.kind === "string" ? declaredInScopes(obj as ResourceManifest) : undefined;
    const inner = declared ? new Map([...(scoped ?? new Map()), ...declared]) : scoped;
    for (const key of Object.keys(obj)) obj[key] = walk(obj[key], inner);
    return value;
  };

  for (const r of resources) {
    if (isForeign(r)) continue;
    if (!r.metadata?.name || !r.kind) continue;
    // A `Telo.Import` is import-time metadata, not a resource instance — except
    // for its `resources:` block, which supplies the instances the target
    // library declared it needs. Those are `!ref`s to the importer's OWN
    // resources and resolve exactly like any other reference; nothing else on
    // the document is a reference slot, so only that subtree is walked.
    if (r.kind === "Telo.Import") {
      const supplied = (r as Record<string, unknown>).resources;
      if (supplied) (r as Record<string, unknown>).resources = walk(supplied);
      continue;
    }
    if (SYSTEM_KINDS.has(r.kind)) continue;
    walk(r as Record<string, unknown>);
  }
}
