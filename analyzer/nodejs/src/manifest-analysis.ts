/**
 * **One analyzed manifest set, and the questions asked of it.**
 *
 * Several answers a host needs require the SAME two things: the registry's
 * definitions and aliases, and the manifest set they were resolved against. The
 * registry deliberately holds no manifests — it is populated per analysis and
 * reused across them — so each such answer would otherwise become another
 * factory on the registry and another optional parameter on every IDE entry
 * point. Four of those arrived in short order (CEL scope, step declarations,
 * context-binding declarations, invocation contracts) and the next one is not
 * hypothetical.
 *
 * So the pairing is named once and the questions hang off it. A host threads ONE
 * object and gains later questions for free; each facet keeps its own honest
 * name rather than accreting onto whichever one happened to exist first.
 *
 * Nothing here re-implements an answer. `contractFor` is the shared
 * {@link resolveContract} — the one `telo check` runs and the kernel binds at
 * dispatch — given the scope to run in; `celScope` is the same
 * {@link CelScopeQuery} the analysis pass's rule is built from. That is the
 * whole point: a completion list is a claim about what the checker accepts, and
 * a second implementation of any of these could not be held to it.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { AliasResolver, moduleScopedDefResolver, type ModuleScopes } from "./alias-resolver.js";
import type { NameLevel } from "./identifier-name.js";
import { levelFor } from "./validate-identifier-names.js";
import { CelScopeQuery, type CelScopeQueryContext } from "./cel-scope-query.js";
import { DefinitionRegistry } from "./definition-registry.js";
import type { ContractDirection } from "./extends-resolution.js";
import { analyzerContractScope, resolveContract } from "./invocation-contract.js";
import { buildCallGraph, type CallGraph } from "./call-graph.js";
import { findManifest } from "./find-manifest.js";
import {
  buildModuleGraph,
  type BuildModuleGraphOptions,
  type ModuleGraph,
  type ModuleGraphDeps,
} from "./module-graph.js";
import { isModuleKind } from "./module-kinds.js";
import type { RefSlot } from "./ref-slot.js";
import { producedOutputContract, referenceOutputRefusal } from "./validate-reference-output.js";
import { buildCelEnvironment, CEL_ENGINE, producedTypeOf } from "@telorun/templating";
import { CatchLadder } from "./catch-scope.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import type { ModuleDocuments } from "./module-documents.js";
import { needGraphFromManifests, resolveNeedTable, type NeedGraph, type NeedTable } from "./need-table.js";
import { needTypeOf } from "./need-type.js";
import { buildOutline, type OutlineDocument } from "./outline.js";

/** An answer kept for the exact `(deps, options)` objects it was built from. */
interface Memo<T> {
  deps: ModuleGraphDeps;
  options: BuildModuleGraphOptions;
  value: T;
}

/** How a tag's fixed produced type is named: its value type, else its JSON type. */
function producedTypeName(schema: Record<string, unknown> | undefined): string | undefined {
  const valueType = schema?.["x-telo-type"];
  if (typeof valueType === "string") return valueType;
  if (valueType && typeof valueType === "object" && typeof (valueType as { name?: unknown }).name === "string") {
    return (valueType as { name: string }).name;
  }
  return typeof schema?.type === "string" ? schema.type : undefined;
}

/**
 * A reference as the loader leaves it — the internal `{kind, name, alias?}`
 * shape `resolveRefSentinels` rewrites `!ref` into.
 */
export interface ManifestRef {
  kind?: string;
  name?: string;
  alias?: string;
}

export class ManifestAnalysis {
  private readonly scopes: ModuleScopes & { rootModules: Set<string> };
  private celScopeQuery: CelScopeQuery | undefined;
  private callGraphMemo: CallGraph | undefined;
  private moduleGraphMemo: Memo<ModuleGraph> | undefined;
  private outlineMemo: Memo<OutlineDocument> | undefined;
  private needsMemo: { graph: NeedGraph; table: NeedTable } | null | undefined;
  private catchLadderMemo: CatchLadder | undefined;

  constructor(
    readonly manifests: ResourceManifest[],
    private readonly ctx: CelScopeQueryContext,
    /** Every imported library's full document set — what the flattened set
     *  forwards only the export surface of. */
    private readonly moduleDocuments: readonly ModuleDocuments[] = [],
  ) {
    const rootModules = new Set<string>();
    for (const m of manifests) {
      if (isModuleKind(m.kind) && m.metadata?.name) rootModules.add(m.metadata.name as string);
    }
    this.scopes = { aliasesByModule: ctx.aliasesByModule, rootModules, libraries: ctx.libraries };
  }

  /** What CEL sees, per site. Built on first use — its indices are a function of
   *  the whole set, and a host that never opens a CEL body should not pay for
   *  them. */
  get celScope(): CelScopeQuery {
    return (this.celScopeQuery ??= new CelScopeQuery(this.manifests, this.ctx));
  }

  /** What calls what. Built on first use and kept, so the projection and any
   *  other consumer over this set share one. */
  private get callGraph(): CallGraph {
    return (this.callGraphMemo ??= buildCallGraph(this.manifests, this.ctx.defs, {
      aliases: this.ctx.aliases,
      aliasesByModule: this.ctx.aliasesByModule,
    }));
  }

  /**
   * The module graph: boxes, ordered rows and classed edges — the projection an
   * editor draws.
   *
   * Here rather than on the registry because it is the registry AND a manifest
   * set, which is the pairing this class exists to name; a fifth
   * `registry.x(manifests, …)` factory is the accretion naming it stopped. It
   * shares this analysis's call graph rather than building one of its own.
   *
   * `deps` is supplied by the registry, which owns capability resolution — this
   * class holds the manifests, not the rules for reading a kind.
   */
  moduleGraph(deps: ModuleGraphDeps, options: BuildModuleGraphOptions = {}): ModuleGraph {
    const memo = this.moduleGraphMemo;
    if (memo && memo.deps === deps && memo.options === options) return memo.value;
    const value = buildModuleGraph(this.manifests, this.callGraph, deps, options);
    this.moduleGraphMemo = { deps, options, value };
    return value;
  }

  /**
   * What the module does, as the `outlineVersion: 1` document: its inputs and
   * what reads them, its boot sequence, its entry points with what each can
   * throw and which `catches:` entry renders it, the resources the module
   * reaches and the ones nothing reaches.
   *
   * A projection of {@link moduleGraph} over exactly its `(deps, options)` —
   * `options.root` is the module doc described — so an outline item's id is
   * the graph's for the same manifest path. Kept for the same objects only.
   */
  outline(deps: ModuleGraphDeps, options: BuildModuleGraphOptions = {}): OutlineDocument {
    const memo = this.outlineMemo;
    if (memo && memo.deps === deps && memo.options === options) return memo.value;
    const root = options.root ?? this.manifests.find((m) => isModuleKind(m.kind));
    const value = buildOutline({
      manifests: this.manifests,
      root,
      graph: this.moduleGraph(deps, options),
      callGraph: this.callGraph,
      definition: (kind, module) => deps.definition(kind, module),
      ladder: this.catchLadder,
      needs: this.needs?.table,
      contract: (manifest, direction) =>
        resolveContract(
          direction,
          manifest as Record<string, any>,
          deps.definition(manifest.kind, (manifest.metadata as { module?: string } | undefined)?.module),
          analyzerContractScope(this.ctx.defs, this.ctx.aliases, this.scopes, this.manifests as Record<string, any>[]),
        )?.schema,
      expressionType: (manifest, path, engine, source) => {
        if (engine !== CEL_ENGINE) return producedTypeName(producedTypeOf(engine));
        const checked = this.celScope.scopeAt(manifest, path).env.check(source);
        // `dyn` is the checker saying it has no type for the expression.
        return checked.valid && checked.typeName !== "dyn" ? checked.typeName : undefined;
      },
      referenceSites: (manifest) => new Set(deps.refSites(manifest).map((site) => site.path)),
    });
    this.outlineMemo = { deps, options, value };
    return value;
  }

  /** The catch ladder of this set, over every imported library's documents —
   *  the reader the coverage pass derives its verdict from. */
  private get catchLadder(): CatchLadder {
    if (this.catchLadderMemo) return this.catchLadderMemo;
    const libraries = new Map<string, ResourceManifest[]>();
    for (const doc of this.moduleDocuments) libraries.set(doc.module, doc.manifests);
    return (this.catchLadderMemo = new CatchLadder(
      this.manifests,
      this.ctx.defs,
      this.ctx.aliases,
      buildCelEnvironment(),
      this.ctx.aliasesByModule,
      this.scopes.rootModules,
      libraries,
    ));
  }

  /** This set's need table, built over its own modules and every imported
   *  library's full documents, each kind resolved in its declaring module's
   *  scope — the table `telo check` reports from. Null when the set holds no
   *  module doc. */
  private get needs(): { graph: NeedGraph; table: NeedTable } | null {
    if (this.needsMemo !== undefined) return this.needsMemo;
    const { defs, aliases, aliasesByModule } = this.ctx;
    const rootModules = this.scopes.rootModules;
    const graph = needGraphFromManifests(
      this.manifests,
      rootModules,
      {
        resolveKind: (module, kind) =>
          declaringModuleScope(module, aliases, { aliasesByModule, rootModules }).resolveKind(kind),
        needType: (kind) => needTypeOf(defs.resolve(kind)),
        isKind: (kind) => defs.resolve(kind) !== undefined,
        referenceSites: (manifest) => defs.referenceSites(manifest, aliases, aliasesByModule),
      },
      this.moduleDocuments,
    );
    return (this.needsMemo = graph ? { graph, table: resolveNeedTable(graph) } : null);
  }

  /** Whether a resource's name denotes a type or a value — the rule the naming
   *  check applies to it, so a rename proposes only a name `telo check` accepts. */
  nameLevel(manifest: ResourceManifest): NameLevel {
    const resolveDef = moduleScopedDefResolver<ResourceDefinition>(this.ctx.defs, this.ctx.aliases, this.scopes);
    return levelFor(manifest, resolveDef, manifest.metadata?.module as string | undefined);
  }

  /** The manifest a `(kind, name)` pair addresses. */
  resourceFor(kind: string | undefined, name: string | undefined): ResourceManifest | undefined {
    return findManifest(this.manifests, kind, name);
  }

  /**
   * The invocation contract of the resource a reference names.
   *
   * The shared resolver, so an editor offering a target's input keys is offering
   * exactly what `telo check` validates that call site against and what the
   * kernel binds at dispatch. Layered instance-first: a resource declaring its
   * own `inputType:` narrows the kind's, which is the common case for a
   * `Run.Sequence` used as a handler.
   */
  contractFor(ref: ManifestRef, direction: ContractDirection): Record<string, any> | undefined {
    const target = this.resolveRef(ref);
    const definition = ref.kind ? this.definitionFor(ref.kind) : undefined;
    if (!target && !definition) return undefined;
    return resolveContract(
      direction,
      target as Record<string, any> | undefined,
      definition,
      analyzerContractScope(
        this.ctx.defs,
        this.ctx.aliases,
        this.scopes,
        this.manifests as Record<string, any>[],
      ),
    )?.schema;
  }

  /**
   * Why the resource `ref` names cannot fill `slot`, by what it RETURNS — one
   * line per definite mismatch against the slot's `x-telo-ref` `outputType`,
   * empty when it can. The verdict `telo check` reports as
   * `REFERENCE_OUTPUT_MISMATCH`, so an editor never offers a target the checker
   * then refuses.
   */
  outputRefusal(slot: RefSlot, ref: ManifestRef): string[] {
    if (!slot.outputType) return [];
    const target = this.resolveRef(ref);
    const definition = ref.kind ? this.definitionFor(ref.kind) : undefined;
    if (!target && !definition) return [];
    const scope = analyzerContractScope(
      this.ctx.defs,
      this.ctx.aliases,
      this.scopes,
      this.manifests as Record<string, any>[],
    );
    return referenceOutputRefusal(
      slot,
      producedOutputContract(target as Record<string, any> | undefined, definition, scope, this.ctx.defs),
      this.ctx.defs,
    );
  }

  /**
   * The manifest a reference names.
   *
   * An ALIAS narrows before the name does: a flattened set carries every
   * imported library's exported instances, so two libraries exporting a `store`
   * are two manifests with one name. Matching the alias to its target module
   * picks the right one; where the alias resolves to nothing the name alone is
   * used, which is what a local reference needs anyway.
   */
  private resolveRef(ref: ManifestRef): ResourceManifest | undefined {
    if (!ref.name) return undefined;
    const byName = this.manifests.filter(
      (m) => (m.metadata as { name?: string } | undefined)?.name === ref.name,
    );
    if (byName.length === 0) return undefined;
    if (byName.length === 1) return byName[0];

    const targetModule = ref.alias ? this.ctx.aliases.moduleForAlias?.(ref.alias) : undefined;
    if (targetModule) {
      const scoped = byName.find(
        (m) => (m.metadata as { module?: string } | undefined)?.module === targetModule,
      );
      if (scoped) return scoped;
    }
    // Several candidates and nothing to choose between them: refusing is the
    // honest answer, since typing a call site against the wrong resource's
    // contract is worse than typing it against none.
    return ref.kind ? byName.find((m) => m.kind === ref.kind) : undefined;
  }

  private definitionFor(kind: string): ResourceDefinition | undefined {
    const canonical = this.ctx.aliases.resolveKind(kind);
    return this.ctx.defs.resolve(kind) ?? (canonical ? this.ctx.defs.resolve(canonical) : undefined);
  }
}

export type { CelScopeQueryContext, AliasResolver, DefinitionRegistry };
