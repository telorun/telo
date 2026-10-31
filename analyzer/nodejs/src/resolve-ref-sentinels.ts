import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { KindResolver } from "./module-alias-scope.js";
import type { ReachSite } from "./reference-reach.js";
import { isKindDocument } from "./kind-declaration.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { isForwardedDeclaration, isForwardedShape } from "./forwarded-declaration.js";
import { forwardedShapeFieldsOf, KIND_SHAPE_FIELDS } from "./contract-shapes.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { refSentinelTarget, type RefSentinelTarget } from "./ref-sentinel-target.js";
import { resolvedReference, type ResolvedReference } from "./resolved-reference.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import {
  declaredScopes,
  keysUnder,
  scopeMembers,
  type DeclaredScope,
} from "./scope-declarations.js";
import { declarationOf, type RefResolution } from "./reference-resolution.js";
import { addressOf, importPathThrough, scopeSiteAt } from "./scoped-name-resolver.js";

/** The slice of the definition registry this pass needs: a resource's concrete
 *  sites, from which its `x-telo-scope` slots are read. */
export interface ScopeSiteSource {
  referenceSites(
    resource: ResourceManifest,
    aliases?: KindResolver,
    aliasesByModule?: ReadonlyMap<string, KindResolver>,
  ): ReachSite[];
}

/** Resolved ref shape written in place of a `!ref` sentinel. `alias` is set only for
 *  cross-module references (resolved into an imported library's exported instance). */
type ResolvedRef = ResolvedReference;

/**
 * Rewrites every `!ref <name>` sentinel in each non-system resource's value tree
 * to a resolved reference — `{__ref, kind, name}` (local) or `{__ref, kind, name,
 * alias}` (cross-module), in place (`resolved-reference.ts`).
 *
 * The walk is value-tree-driven, not reach-driven: a `!ref` tag is an
 * *explicit* reference marker, so any sentinel found anywhere is unambiguously a
 * reference and is resolved. This reaches sites the reference reach
 * intentionally stops before — notably `Run.Sequence` step `invoke`s (in a step
 * body) and references nested inside inline definitions — so every downstream consumer
 * (Phase-5 injection, the runtime controllers, the analyzer's step-context and
 * dependency passes) sees the uniform `{kind, name}` shape regardless of where
 * the reference was written.
 *
 * Resolving a sentinel here does NOT cause Phase-5 injection: that pass is
 * driven by the reach's concrete sites, which exclude step `invoke`s, so a resolved
 * step invoke stays `{kind, name}` and is dispatched through
 * `executeInvokeStep` (preserving `<name>.Invoked` events) rather than
 * being replaced with a live instance.
 *
 * What a sentinel names is the `!ref` engine's verdict the loader attached
 * (`ref-sentinel-target.ts`), never a reading of its text here:
 *   - `!ref writeLine`          → local resource `writeLine`
 *   - `!ref Self.writeLine`     → local resource `writeLine` (explicit self-qualifier)
 *   - `!ref Console.writeLine`  → instance `writeLine` exported by the import aliased
 *                                 `Console`, resolved against the forwarded foreign set
 *   - `!ref stores[each.key]`   → `stores`, its indexes carried on the resolved reference
 *
 * A text the grammar refuses is left as written. When the
 * name doesn't resolve (e.g. a scope-local target, or a cross-module reference in
 * partial single-file analysis), the sentinel is left in place — the runtime
 * resolves scope-local names on demand, and `validateReferences` emits the
 * `UNRESOLVED_REFERENCE` diagnostic for genuine misses.
 *
 * Forwarded foreign resources (an imported library's exported instances, carrying a
 * `metadata.module` that isn't a root module) are resolution TARGETS only — they are not
 * re-walked as sources here, since their own ref slots belong to their own module scope.
 * The shapes a forwarded contract or signature names are the exception, resolved in the
 * DECLARING module's scope (see `contract-shapes.ts`).
 */
export function resolveRefSentinels(
  resources: ResourceManifest[],
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  /** What a name resolves to. The kernel and a configuration's analysis pass
   *  {@link listResolution} over `resources` — the kernel with the
   *  analyzer-flattened set as cross-module targets, so the runtime pass, which
   *  loads the entry module only, still resolves `!ref Alias.name` against an
   *  imported library's exported instances. */
  resolution: RefResolution,
  /** Supplies each kind's `x-telo-scope` slots. Without it a scoped name cannot be
   *  told from a module-level one, and a shadowed `!ref` resolves to the resource
   *  it shadows — so both call sites pass it. */
  defs?: ScopeSiteSource,
): void {
  resolveReferences(resources, aliases, aliasesByModule, resolution, defs, "all");
}

/**
 * {@link resolveRefSentinels}, restricted to the shapes a contract or a signature
 * names — for a manifest set whose ordinary reference slots must keep their
 * authored form. The analyzer runs it over the documents its definition registry
 * holds, which were registered before the clone every other pass reads, so a
 * kind's contract read through the registry names the same shapes.
 */
export function resolveShapeRefs(
  resources: ResourceManifest[],
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  resolution: RefResolution,
): void {
  resolveReferences(resources, aliases, aliasesByModule, resolution, undefined, "shapes");
}

function resolveReferences(
  resources: ResourceManifest[],
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  resolution: RefResolution,
  defs: ScopeSiteSource | undefined,
  extent: "all" | "shapes",
): void {
  const moduleOf = (r: ResourceManifest): string | undefined =>
    (r.metadata as { module?: string } | undefined)?.module;
  // A dependency's code — a forwarded export, or what extraction pulled out of one — is
  // never walked as a local ref source here and never a local name; only an EXPORT is a
  // cross-module resolution target.
  const isForeign = isForwardedDeclaration;
  const { local: names, exported: exportedBy, declared: declaredBy } = resolution;

  const resolveTarget: Resolve = (target, at) => {
    const { alias, name, indexes } = target;
    if (alias === undefined || alias === "Self") {
      const t = names.locate(name, at.module, at.within);
      // A choice nothing decides stands in with no kind: its `!ref` stays as
      // written, resolved by name and judged by kind by no pass.
      return t.status === "resolved" ? resolvedReference(t.declaration.kind as string, name, undefined, indexes) : undefined;
    }
    return resolveExported(alias, name, aliases, at.writer);
  };

  /** `Alias.name` → the instance the import aliased `Alias` exports, read through
   *  the alias table of whichever module wrote the reference. */
  const resolveExported = (
    alias: string,
    name: string,
    scope: Pick<AliasResolver, "moduleForAlias"> | undefined,
    writer: ResourceManifest | undefined,
  ): ResolvedRef | undefined => {
    const module = scope?.moduleForAlias(alias);
    if (module) {
      // The export of the module instance this writer's import reaches.
      const found = exportedBy.inModule(name, module, importPathThrough(writer, alias));
      if (found.status === "resolved") {
        // The foreign instance's `kind` is authored in ITS module's scope (e.g.
        // `Self.WriteLine`); canonicalize to a scope-independent `<module>.<Kind>` for the
        // consumer's kind check. `Self.` maps to the owning module directly — the forwarded
        // library's Library doc (hence its `Self` alias) isn't in the consumer's manifest
        // set — while other alias prefixes resolve via that module's forwarded import scope.
        const rawKind = found.declaration.kind as string;
        const foreignKind = rawKind.startsWith("Self.")
          ? `${module}.${rawKind.slice("Self.".length)}`
          : aliasesByModule?.get(module)?.resolveKind(rawKind) ?? rawKind;
        return resolvedReference(foreignKind, name, alias);
      }
    }
    return undefined;
  };

  /** How a shape reference in `doc` resolves: in the scope of the module that
   *  declared `doc`. A forwarded kind document carries no forwarding stamp — only
   *  its module says it is a dependency's — so the declaring module is what
   *  decides, and the ordinary rule applies only to a document of the entry's own
   *  module (a root module's `aliasesByModule` key, if any, is the top-level table). */
  const shapeResolverFor = (doc: ResourceManifest): Resolve => {
    const module = moduleOf(doc);
    const ownedByEntry =
      !isForeign(doc) && (module === undefined || !aliasesByModule?.has(module));
    if (ownedByEntry) return resolveTarget;
    const scope = moduleAliasScope(doc.metadata, aliases, aliasesByModule);
    return ({ alias, name, indexes }) => {
      if (alias === undefined || alias === "Self") {
        const t = declarationOf(declaredBy.inModule(name, module));
        return t ? resolvedReference(t.kind as string, name, undefined, indexes) : undefined;
      }
      return resolveExported(alias, name, scope, doc);
    };
  };

  /** The execution scopes a declaration holds, read from its kind's
   *  `x-telo-scope` slots — the analyzer's single definition of "scope", shared
   *  with `manifest-visitor`. Inferring it structurally instead (any array of
   *  named inline manifests) would give scope-local shadowing to the first kind
   *  that happens to carry such an array without asking for it, and this pass is
   *  shared with the kernel, so the guess would be baked into the runtime tree
   *  rather than merely reported. */
  const holderAt = (address: ScopeAddress, resource: ResourceManifest): WalkHolder => {
    const scopes = defs ? declaredScopes(defs.referenceSites(resource, aliases, aliasesByModule)) : [];
    for (const scope of scopes) {
      names.declareScope({ holder: address, field: scope.path }, scopeMembers(scope));
    }
    return { address, scopes };
  };

  // Resolve every `!ref` sentinel in the tree; leave opaque tagged / precompiled
  // nodes (e.g. `!cel`) untouched and don't descend into them.
  //
  // Each name is read where it is written — through the scopes of the
  // declarations enclosing it, at any depth, then the module — so a name a
  // scope declares SHADOWS the module-level one in that scope, the order the
  // runtime resolves in. Baking the module-level kind into a shadowed reference
  // would label traces and `getRefIdentity` with a resource that never runs.
  // `keys` is the place below the nearest enclosing declaration.
  const walk = (
    value: unknown,
    at: WalkSite,
    resolve: Resolve,
    keys: (string | number)[],
  ): unknown => {
    if (isRefSentinel(value)) {
      // A text outside the `!ref` grammar is left as written; the expansion
      // reader reports it (`REF_MEMBER_INVALID`).
      const target = refSentinelTarget(value);
      if (!target) return value;
      const within = at.holder ? scopeSiteAt(at.holder.address, at.holder.scopes, keys) : undefined;
      return resolve(target, { module: at.module, within, writer: at.writer }) ?? value;
    }
    if (value === null || typeof value !== "object") return value;
    if (isTaggedSentinel(value)) return value;
    if ((value as { __compiled?: unknown }).__compiled) return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        keys.push(i);
        value[i] = walk(value[i], at, resolve, keys);
        keys.pop();
      }
      return value;
    }
    const obj = value as Record<string, unknown>;
    // A nested inline declaration may declare scopes of its own (a
    // `Run.Sequence` inside another sequence's `with:`): its own fields read
    // names through them, then through every scope it is written in.
    if (typeof obj.kind === "string" && at.holder) {
      const inner: WalkSite = {
        module: at.module,
        writer: at.writer,
        holder: holderAt(nestedAddress(at.holder, keys, obj), obj as ResourceManifest),
      };
      for (const key of Object.keys(obj)) obj[key] = walk(obj[key], inner, resolve, [key]);
      return value;
    }
    for (const key of Object.keys(obj)) {
      keys.push(key);
      obj[key] = walk(obj[key], at, resolve, keys);
      keys.pop();
    }
    return value;
  };

  /** A top-level declaration as the walk's first holder. */
  const rootSite = (r: ResourceManifest): WalkSite => {
    const address = addressOf(r);
    return {
      module: moduleOf(r),
      writer: r,
      holder: address ? holderAt(address, r) : undefined,
    };
  };

  const walkShapeFields = (r: ResourceManifest, fields: readonly string[]): void => {
    const resolve = shapeResolverFor(r);
    const record = r as Record<string, unknown>;
    for (const field of fields) {
      if (record[field] !== undefined) {
        record[field] = walk(record[field], { module: moduleOf(r), writer: r }, resolve, [field]);
      }
    }
  };

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind) continue;
    // A dependency's code is not walked as a source — its references belong to
    // its own module — with one exception: the shapes its contract and signature
    // name, resolved in the module that wrote them.
    if (isForeign(r)) {
      walkShapeFields(r, isForwardedShape(r) ? ["schema"] : forwardedShapeFieldsOf(r));
      continue;
    }
    if (extent === "shapes") {
      if (r.kind === "Telo.Definition" || r.kind === "Telo.Abstract") {
        walkShapeFields(r, KIND_SHAPE_FIELDS);
      }
      continue;
    }
    // A `Telo.Import` is import-time metadata, not a resource instance — except
    // for its `resources:` block, which supplies the instances the target
    // library declared it needs. Those are `!ref`s to the importer's OWN
    // resources and resolve exactly like any other reference; nothing else on
    // the document is a reference slot, so only that subtree is walked.
    if (r.kind === "Telo.Import") {
      const supplied = (r as Record<string, unknown>).resources;
      if (supplied) {
        (r as Record<string, unknown>).resources = walk(
          supplied,
          { module: moduleOf(r), writer: r },
          resolveTarget,
          ["resources"],
        );
      }
      continue;
    }
    // A kind document's own ref slots belong to definition-schema validation
    // rather than to a resource's value tree, which is why it is skipped. Its
    // CONTRACT and SIGNATURE are the exception, for the reason
    // `Telo.Import`'s `resources:` block is: `inputType` / `outputType` and
    // `params[].schema` / `returns.schema` hold a `!ref` to a `Telo.JsonSchema`,
    // and it resolves there exactly as it does on an instance. Only those
    // subtrees are walked — the rest of the document keeps its unresolved
    // references.
    if (isKindDocument(r)) {
      if (r.kind === "Telo.Definition" || r.kind === "Telo.Abstract") {
        walkShapeFields(r, KIND_SHAPE_FIELDS);
      }
      continue;
    }
    const site = rootSite(r);
    const record = r as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = walk(record[key], site, resolveTarget, [key]);
    }
  }
}

/** Where a walked value is read: the module that wrote it, and the nearest
 *  declaration enclosing it with the scopes that declaration holds. */
interface WalkSite {
  module: string | undefined;
  holder?: WalkHolder;
  /** The top-level declaration being walked. */
  writer?: ResourceManifest;
}

interface WalkHolder {
  address: ScopeAddress;
  scopes: readonly DeclaredScope[];
}

type Resolve = (
  target: RefSentinelTarget,
  at: { module: string | undefined; within: ScopeSite | undefined; writer?: ResourceManifest },
) => ResolvedRef | undefined;

/**
 * The address of a declaration written at `keys` below `holder`: a member of
 * one of the holder's scopes is addressed by its name in that scope; any other
 * declaration — an inline one at a slot — by the place it is written, in the
 * scope it is read in.
 */
function nestedAddress(
  holder: WalkHolder,
  keys: readonly (string | number)[],
  declaration: Record<string, unknown>,
): ScopeAddress {
  const name = (declaration.metadata as { name?: unknown } | undefined)?.name;
  const scope = holder.scopes.find((s) => keys.length === s.keys.length + 1 && keysUnder(keys, s.keys));
  if (scope && typeof name === "string") {
    return scopeAddress({ holder: holder.address, field: scope.path }, name);
  }
  const place = keys.map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("");
  return scopeAddress(
    scopeSiteAt(holder.address, holder.scopes, keys) ?? holder.address.module,
    `${holder.address.member}${place}`,
  );
}
