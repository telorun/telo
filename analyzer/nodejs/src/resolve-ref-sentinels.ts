import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { REF_RESOLUTION_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

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
 * `executeInvokeStep` (preserving `<Kind>.<Name>.Invoked` events) rather than
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

  // Resolve every `!ref` sentinel in the tree; leave opaque tagged / precompiled
  // nodes (e.g. `!cel`) untouched and don't descend into them.
  const walk = (value: unknown): unknown => {
    if (isRefSentinel(value)) {
      return resolveTarget(value.source) ?? value;
    }
    if (value === null || typeof value !== "object") return value;
    if (isTaggedSentinel(value)) return value;
    if ((value as { __compiled?: unknown }).__compiled) return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) obj[key] = walk(obj[key]);
    return value;
  };

  for (const r of resources) {
    if (isForeign(r)) continue;
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;
    walk(r as Record<string, unknown>);
  }
}
