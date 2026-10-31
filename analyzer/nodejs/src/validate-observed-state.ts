import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { DeclarationRequests } from "./declaration-requests.js";
import { isKindDocument } from "./kind-declaration.js";
import { OBSERVED_STATE_KEY } from "@telorun/sdk";
import { celExpressionsOf, INDEX_SEGMENT } from "@telorun/templating";
import { accessChains } from "./cel-access-chains.js";
import { celEvalModeAt, governedCelEvalSites, type CelEvalSites } from "./eval-paths.js";
import { effectiveStatusSchema, inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { parseExportEntry } from "./flatten-for-analyzer.js";
import {
  moduleScopedDefResolver,
  type AliasResolver,
  type ModuleScopes,
} from "./alias-resolver.js";
import type { CallGraph } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { definitionInScope, type KindResolver } from "./module-alias-scope.js";
import { injectedNeedOf, needReadingSchema, needTypeOf } from "./need-type.js";
import { isOptionalResourceInput } from "./resource-input.js";
import { scopeAddress, scopeSiteKey, type ScopeSite } from "./scope-address.js";
import { reachSites } from "./reference-reach.js";
import {
  celScopeAt,
  celScopeHolder,
  declaredScopes,
  isScopeMember,
  type CelScopeHolder,
} from "./scope-declarations.js";
import { addressOf, importPathThrough, ofInstance, ScopedNameResolver } from "./scoped-name-resolver.js";
import type { ReachSite } from "./reference-reach.js";
import type { ScopedResources } from "./kernel-globals.js";
import { scopeMemberOf, walkOwnCelExpressions } from "./scope-members.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

/** A document that declares a kind, a module or an import — no resource. */
const isSystemDocument = (m: { kind?: unknown }): boolean =>
  m.kind === "Telo.Import" ||
  m.kind === "Telo.Application" ||
  m.kind === "Telo.Library" ||
  isKindDocument(m);

/**
 * `required:` inside a `status:` block. Every declared field is mandatory once
 * the resource has run, so the list would be either redundant or a lie; a
 * genuinely sometimes-absent value is declared with a nullable type, which
 * `CEL_NULLABLE_ACCESS` already guards.
 */
export function validateObservedStateDeclarations(
  manifests: readonly ResourceManifest[],
): Array<{ kind: string; name: string; filePath?: string; message: string }> {
  const out: Array<{ kind: string; name: string; filePath?: string; message: string }> = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const status = (m as { status?: Record<string, any> }).status;
    if (!status || typeof status !== "object" || !Array.isArray(status.required)) continue;
    const name = (m.metadata?.name as string | undefined) ?? "<unnamed>";
    out.push({
      kind: m.kind as string,
      name,
      filePath: (m.metadata as { source?: string } | undefined)?.source,
      message:
        `${m.kind}/${name}: 'status:' must not declare 'required:' — every field a kind declares ` +
        `it reports is mandatory once the resource has run, so the list is either redundant or a ` +
        `lie. Declare a sometimes-absent field with a nullable type instead ` +
        `(e.g. type: [string, "null"]); CEL_NULLABLE_ACCESS then forces the reader to guard it.`,
    });
  }
  return out;
}

/** `OBSERVED_STATE_REQUIRED_FORBIDDEN` for every kind document declaring one. */
export function observedStateRequiredDiagnostics(manifests: readonly ResourceManifest[]): AnalysisDiagnostic[] {
  return validateObservedStateDeclarations(manifests).map((issue) => ({
    severity: DiagnosticSeverity.Error,
    code: "OBSERVED_STATE_REQUIRED_FORBIDDEN",
    source: "telo-analyzer",
    message: issue.message,
    data: {
      resource: { kind: issue.kind, name: issue.name },
      filePath: issue.filePath,
      path: "status.required",
    },
  }));
}

/** A CEL access into a resource's observed-state segment. */
export interface ObservedStateRead {
  /** Import alias, when the read crosses a module boundary
   *  (`resources.<Alias>.<name>.status`). */
  alias?: string;
  /** Resource name. */
  name: string;
  /** The field read under `.status`, when the chain names one. */
  field?: string;
}

/**
 * Recognise an observed-state read in a member-access chain. Purely syntactic —
 * it inspects the chain, not the topology — so the availability rule it feeds
 * applies to every kind, declared or not.
 *
 * `resources.<name>.status.<field>` and the two-level cross-module form
 * `resources.<Alias>.<name>.status.<field>` are both observed-state reads.
 */
export function observedStateRead(written: readonly string[]): ObservedStateRead | undefined {
  // An index (`resources.crons[each.key].status.x`) selects a family member:
  // the read is of the family's kind, whatever the key.
  const chain = written.filter((segment) => segment !== INDEX_SEGMENT);
  if (chain[0] !== "resources") return undefined;
  if (chain[2] === OBSERVED_STATE_KEY) return { name: chain[1]!, field: chain[3] };
  if (chain[3] === OBSERVED_STATE_KEY) {
    return { alias: chain[1], name: chain[2]!, field: chain[4] };
  }
  return undefined;
}

/**
 * Whether a resource of this (effective) capability reports observed state from
 * `init()`. A `Telo.Provider` has no `run()`: its `init()` is where it becomes
 * what it provides, so what it learns there is published when `init()` returns
 * and is readable wherever a value resolves at startup. Every other capability
 * reports only once it has started.
 */
export function reportsFromInit(capability: string | undefined): boolean {
  return capability === "Telo.Provider";
}

/**
 * Every observed-state read an expression of `manifest` makes in a field that
 * resolves at startup (compile-eval), as `sites` place them. Such a read needs
 * its producer initialized before the reader is created, so it is an init-order
 * edge in `telo check` and a deferral in the kernel — one reader for both.
 */
export function startupObservedStateReads(
  manifest: ResourceManifest,
  sites: CelEvalSites,
): ObservedStateRead[] {
  if (sites.compile.length === 0) return [];
  const reads: ObservedStateRead[] = [];
  walkOwnCelExpressions(manifest, "", (source, path, engine) => {
    if (!source.includes(OBSERVED_STATE_KEY)) return;
    if (celEvalModeAt(sites, path) !== "compile") return;
    for (const expression of celExpressionsOf(engine, source)) {
      for (const chain of accessChains(expression)) {
        const read = observedStateRead(chain);
        if (read) reads.push(read);
      }
    }
  });
  return reads;
}

/**
 * The names of every resource some slot can start.
 *
 * One question, one answer: a resource is run-reachable when a control-
 * transferring edge reaches it in the typed reference graph. `call`, `detached`,
 * `trigger.inbound` and `trigger.consumer` all mean control arrives; `schema` and
 * `dependency` mean it never does.
 *
 * This replaced two independent over-approximations that had to agree by
 * coincidence: a field-map scan keeping slots whose *constraint capability*
 * looked runnable, plus an untyped whole-manifest scan for the declared step
 * invoke key at any depth. Both were guesses at the question `use` now answers —
 * and the first was wrong in the direction that rejects valid manifests, since a
 * slot constrained to `Telo.Invocable` can still be dispatched through `run()`.
 */
export function collectRunReachableNames(graph: CallGraph): Set<string> {
  // By NAME, not by resolved node: a `with:`-scoped resource is started by its
  // sequence's `targets:` while never being a top-level node, so resolving first
  // would report it as unstartable. The graph is passed in, never built here —
  // one build per analysis, shared with every other graph consumer.
  const names = new Set<string>();
  for (const edge of graph.controlEdges()) names.add(edge.toName);
  return names;
}


/** What a resource name resolves to for CEL purposes. `status` is present only
 *  when the kind declares one; `capability` is the kind's effective capability
 *  (through `extends`); `scoped` marks a resource declared inside an
 *  `x-telo-scope` slot, which resolves only within that scope's regions, and
 *  `scope` names that slot: the declaring resource and the field holding it.
 *  `forwardedFrom` marks a dependency's declaration, keyed by
 *  `forwardedResourceKey`: it is in no consumer's `resources`, but a read inside
 *  that dependency's own manifests still resolves to it. */
export interface AnalyzedResource {
  kind: string;
  status?: Record<string, any>;
  /** What `resources.<name>` reads as: CLOSED when the kind declares its
   *  reading — a need type's fields — and nullable, its flat half open, for a
   *  library's `optional: true` resource input. Absent for every other
   *  resource, whose flat reading stays open. */
  reading?: Record<string, any>;
  capability?: string;
  scoped?: boolean;
  scope?: { kind: string; name?: string; field: string };
  forwardedFrom?: string;
}

/** What an `optional: true` resource input reads as inside its library: the
 *  kind's reading, or `null` when the importer omits it. */
function optionalInputReading(status: Record<string, any> | undefined): Record<string, any> {
  return {
    type: ["object", "null"],
    additionalProperties: true,
    ...(status ? { properties: { [OBSERVED_STATE_KEY]: { ...status, additionalProperties: false } } } : {}),
  };
}

/** The index key of a name a dependency declares, as read from inside it. */
export function forwardedResourceKey(module: string, name: string): string {
  return `${module}\0${name}`;
}

/**
 * Index every resource a CEL `resources.…` read can name: the module's own
 * top-level resources by name, every scope member (`scopeMemberOf`) by its
 * address, and each import's exported instances — keyed `<Alias>.<name>`, the
 * two-level shape those publish under.
 */
export function buildObservedStateIndex(
  declarations: DeclarationRequests,
  defs: { resolve(kind: string): ResourceDefinition | undefined },
  aliases?: { resolveKind(kind: string): string | undefined; moduleForAlias?(alias: string): string | undefined },
  scopes?: ModuleScopes,
): Map<string, AnalyzedResource> {
  const out = new Map<string, AnalyzedResource>();
  for (const declaration of observedDeclarations(declarations, defs, aliases, scopes)) {
    out.set(declaration.key, declaration.resource);
  }
  return out;
}

/** One resource a `resources.…` read can name, with where it is declared. */
export interface ObservedDeclaration {
  /** Its key in {@link buildObservedStateIndex}. */
  key: string;
  /** The name a bare read uses; absent for an import's exported instance. */
  name?: string;
  module?: string;
  /** The scope declaring it, for a scope member. */
  site?: ScopeSite;
  resource: AnalyzedResource;
}

/**
 * What a bare `resources.<name>` read names, scope first: `local` holds the
 * entry's own declarations and the scopes their holders declare, `forwarded`
 * a dependency's, read only from inside that dependency.
 */
export function observedStateNames(declarations: Iterable<ObservedDeclaration>): {
  local: ScopedNameResolver<ObservedDeclaration>;
  forwarded: ScopedNameResolver<ObservedDeclaration>;
} {
  const reading = { nameOf: (d: ObservedDeclaration) => d.name, moduleOf: (d: ObservedDeclaration) => d.module };
  const all = [...declarations];
  const topLevel = all.filter((d) => d.name !== undefined && !d.resource.scoped);
  const local = new ScopedNameResolver(
    topLevel.filter((d) => d.resource.forwardedFrom === undefined),
    reading,
  );
  const forwarded = new ScopedNameResolver(
    topLevel.filter((d) => d.resource.forwardedFrom !== undefined),
    reading,
  );
  const bySite = new Map<string, { site: ScopeSite; members: ObservedDeclaration[] }>();
  for (const d of all) {
    if (!d.site) continue;
    const key = scopeSiteKey(d.site);
    const entry = bySite.get(key);
    if (entry) entry.members.push(d);
    else bySite.set(key, { site: d.site, members: [d] });
  }
  for (const { site, members } of bySite.values()) {
    (members[0]!.resource.forwardedFrom === undefined ? local : forwarded).declareScope(site, members);
  }
  return { local, forwarded };
}

/**
 * A declaration's reach sites and its {@link CelScopeHolder}: its reach, its
 * kind's author schema and its eval sites, each resolved in its declaring
 * module.
 */
export function celScopeHolderOf(
  m: ResourceManifest,
  defs: DefinitionRegistry,
  aliases: KindResolver | undefined,
  aliasesByModule: ReadonlyMap<string, KindResolver> | undefined,
): { sites: ReachSite[]; holder: CelScopeHolder } {
  const definition = definitionInScope<ResourceDefinition>(
    defs,
    m.kind,
    m.metadata,
    aliases,
    aliasesByModule,
  );
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope(defs, kind, from?.metadata ?? m.metadata, aliases, aliasesByModule);
  const sites = defs.referenceSites(m, aliases, aliasesByModule);
  return {
    sites,
    holder: celScopeHolder(
      m,
      sites,
      defs.effectiveSchemaOf(definition) as Record<string, any> | undefined,
      governedCelEvalSites(definition, resolveDef, defs.shapeLookup),
    ),
  };
}

/** {@link ScopedResources}, plus the declaration a member of a scope is. */
export interface ScopedObservedResources extends ScopedResources {
  /** The member `name` of `site` itself — never an enclosing scope's. */
  member(site: ScopeSite, name: string): AnalyzedResource | undefined;
}

/**
 * What the `resources` record holds inside each scope, from the declarations
 * {@link observedDeclarations} yields: a scope's members, read in a region of
 * the resource declaring the scope outside its compile-eval fields — never in a
 * member's own fields, in an inline declaration written inside a region, or
 * (`at` naming one scope only) in a nested scope's regions, as the kernel's
 * scope run binds `resources` (`celScopeAt`). `holderOf` describes a
 * declaration's reference sites and eval sites ({@link celScopeHolderOf}).
 */
export function scopedResourcesOf(
  declarations: readonly ObservedDeclaration[],
  holderOf: (manifest: ResourceManifest) => {
    sites: readonly ReachSite[];
    holder: CelScopeHolder;
  },
): ScopedObservedResources {
  // A dependency's members are in no consumer's record: its resources read
  // open, typed in its own module.
  const bySite = new Map<string, ObservedDeclaration[]>();
  for (const d of declarations) {
    if (!d.site || d.name === undefined || d.resource.forwardedFrom !== undefined) continue;
    const key = scopeSiteKey(d.site);
    const list = bySite.get(key);
    if (list) list.push(d);
    else bySite.set(key, [d]);
  }
  const holders = new WeakMap<
    ResourceManifest,
    { scopes: ReturnType<typeof declaredScopes>; holder: CelScopeHolder }
  >();
  return {
    at(m, path) {
      if (bySite.size === 0) return undefined;
      const address = addressOf(m);
      if (!address) return undefined;
      let known = holders.get(m);
      if (!known) {
        const { sites, holder } = holderOf(m);
        holders.set(m, (known = { scopes: declaredScopes(sites), holder }));
      }
      const scope = celScopeAt(known.holder, known.scopes, path);
      return scope ? { holder: address, field: scope.path } : undefined;
    },
    members: (site) =>
      (bySite.get(scopeSiteKey(site)) ?? []).map((d) => ({
        name: d.name!,
        ...(d.resource.status ? { status: d.resource.status } : {}),
        ...(d.resource.reading ? { reading: d.resource.reading } : {}),
      })),
    member: (site, name) => bySite.get(scopeSiteKey(site))?.find((d) => d.name === name)?.resource,
  };
}

/** What a resource of `kind`, written in `module`, reads as: its observed
 *  state, its reading and its capability. */
export function analyzedKind(
  resolve: {
    in(kind: string, module?: string): ResourceDefinition | undefined;
    (kind: string, from?: { metadata?: { module?: string } }): ResourceDefinition | undefined;
  },
  kind: string,
  module?: string,
  optionalNeed = false,
  optionalInput = false,
): AnalyzedResource {
  const definition = resolve.in(kind, module);
  const status = effectiveStatusSchema(definition, resolve);
  const capability = inheritedCapability(definition, resolve);
  const needType = needTypeOf(definition);
  const reading = needType
    ? needReadingSchema(needType, optionalNeed)
    : optionalInput
      ? optionalInputReading(status)
      : undefined;
  return {
    kind,
    ...(status ? { status } : {}),
    ...(reading ? { reading } : {}),
    ...(capability ? { capability } : {}),
  };
}

/** Every resource a CEL `resources.…` read can name, in index order. */
export function* observedDeclarations(
  declarations: DeclarationRequests,
  defs: { resolve(kind: string): ResourceDefinition | undefined },
  aliases?: { resolveKind(kind: string): string | undefined; moduleForAlias?(alias: string): string | undefined },
  scopes?: ModuleScopes,
): Generator<ObservedDeclaration> {
  const resolve = moduleScopedDefResolver(defs, aliases, scopes);

  /** `module` is the resource's DECLARING module: an exported instance is
   *  written with that library's aliases (`kind: Self.Listener`), which the
   *  consumer's table cannot resolve. */
  const analyzed = (
    kind: string,
    scope: AnalyzedResource["scope"],
    module?: string,
    forwardedFrom?: string,
    optionalNeed = false,
    optionalInput = false,
  ): AnalyzedResource => {
    const read = analyzedKind(resolve, kind, module, optionalNeed, optionalInput);
    return {
      ...read,
      ...(scope ? { scoped: true, scope } : {}),
      ...(forwardedFrom !== undefined ? { forwardedFrom } : {}),
    };
  };

  for (const manifest of declarations.published()) {
    const kind = manifest.kind as string | undefined;
    const name = manifest.metadata?.name as string | undefined;
    if (!kind || !name || isSystemDocument(manifest)) continue;
    const module = manifest.metadata?.module as string | undefined;
    // A scope member is named only inside its scope, filed under its address.
    const member = scopeMemberOf(manifest);
    if (member) {
      const holder = member.holder;
      yield {
        key: member.address.key,
        name,
        module,
        site: member.site,
        resource: analyzed(
          kind,
          { kind: holder.kind, name: holder.metadata?.name as string | undefined, field: member.site.field },
          module,
          isForwardedDeclaration(manifest) ? module : undefined,
        ),
      };
      continue;
    }
    // A dependency's declarations publish into ITS module's `resources`, not this
    // one's: they are keyed by that module, and an export is also indexed under
    // `<Alias>.<name>` below.
    const forwardedFrom = isForwardedDeclaration(manifest) ? module : undefined;
    if (forwardedFrom === undefined && isForwardedDeclaration(manifest)) continue;
    yield {
      key: forwardedFrom === undefined ? name : forwardedResourceKey(forwardedFrom, name),
      name,
      module,
      resource: analyzed(
        kind,
        undefined,
        module,
        forwardedFrom,
        injectedNeedOf(manifest)?.optional === true,
        isOptionalResourceInput(manifest),
      ),
    };

    // A set `telo check` did not prepare (an editor's projection) holds its
    // scope members inside their holders only: they are read there.
    const schema = resolve.in(kind, module)?.schema as Record<string, any> | undefined;
    if (!schema) continue;
    const holder = scopeAddress(module, name);
    for (const site of reachSites(schema, manifest)) {
      if (site.scopes.length === 0 || !Array.isArray(site.data)) continue;
      const scope: ScopeSite = { holder, field: site.path };
      for (const entry of site.data) {
        if (!isScopeMember(entry) || scopeMemberOf(entry) || isSystemDocument(entry)) continue;
        const memberName = entry.metadata.name;
        yield {
          key: scopeAddress(scope, memberName).key,
          name: memberName,
          module,
          site: scope,
          resource: analyzed(entry.kind, { kind, name, field: site.path }, module, forwardedFrom),
        };
      }
    }
  }

  for (const [alias, name, kind, module] of importedExports(declarations, aliases)) {
    yield { key: `${alias}.${name}`, module, resource: analyzed(kind, undefined, module) };
  }
}

/**
 * Every `<alias, exported name, kind>` an import makes readable as
 * `resources.<Alias>.<name>`. The importer's `Telo.Import` docs give the
 * aliases; the exported instances are the ones already stamped
 * `metadata.forwardedExport` by `selectModuleManifestsForAnalysis` — the module
 * doc that declared `exports.resources` is dropped for non-root modules, so the
 * stamp, not the declaration, is what survives into the consumer's manifest
 * list. A module doc is still consulted when one IS present (a single-library
 * analysis, the editor's projection).
 */
function* importedExports(
  declarations: DeclarationRequests,
  aliases?: { moduleForAlias?(alias: string): string | undefined },
): Generator<[alias: string, name: string, kind: string, module: string]> {
  if (!aliases?.moduleForAlias) return;

  const declaredByModule = new Map<string, Set<string>>();
  for (const m of declarations.moduleDocuments()) {
    if (m.kind !== "Telo.Library") continue;
    const libName = (m.metadata?.name ?? m.metadata?.module) as string | undefined;
    const declared = (m as { exports?: { resources?: unknown[] } }).exports?.resources;
    if (!libName || !Array.isArray(declared)) continue;
    declaredByModule.set(
      libName,
      new Set(
        declared
          .filter((e): e is string => typeof e === "string")
          .map((e) => parseExportEntry(e).name),
      ),
    );
  }

  // One declaration per name and module instance: a library imported several
  // times is forwarded once per import.
  const exportsByModule = new Map<string, Map<string, ResourceManifest[]>>();
  for (const m of declarations.published()) {
    const module = m.metadata?.module as string | undefined;
    const name = m.metadata?.name as string | undefined;
    if (!module || !name || isSystemDocument(m)) continue;
    const forwarded = (m.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport;
    if (!forwarded && !declaredByModule.get(module)?.has(name)) continue;
    let byName = exportsByModule.get(module);
    if (!byName) exportsByModule.set(module, (byName = new Map()));
    byName.set(name, [...(byName.get(name) ?? []), m]);
  }

  for (const m of declarations.published()) {
    if (m.kind !== "Telo.Import") continue;
    const alias = m.metadata?.name as string | undefined;
    if (!alias) continue;
    const targetModule = aliases.moduleForAlias(alias);
    const exported = targetModule && exportsByModule.get(targetModule);
    if (!exported) continue;
    const reached = importPathThrough(m, alias);
    for (const [name, declared] of exported) {
      const instance = ofInstance(declared, reached)[0];
      if (instance) yield [alias, name, instance.kind as string, targetModule];
    }
  }
}

/** The `resources` node of a CEL context schema: one entry per resource, each
 *  open except for a typed, closed `status` node on kinds that declare one.
 *  `open` keeps the map itself permissive, so unknown resource names and every
 *  flat field pass exactly as they do today. */
export function buildObservedStateResourcesSchema(
  index: ReadonlyMap<string, AnalyzedResource>,
  open: boolean,
): Record<string, any> {
  const properties: Record<string, any> = {};
  for (const [key, { status, reading, forwardedFrom, scoped }] of index) {
    if (forwardedFrom !== undefined || scoped) continue;
    if (reading) applyReadingNode(properties, key, reading);
    else if (status) applyObservedStateNode(properties, key, status);
  }
  return open
    ? { type: "object", additionalProperties: true, properties }
    : { type: "object", properties };
}

/**
 * Write a CLOSED reading for one index key into a `resources` property map —
 * a fulfilment's fields, which are all it publishes. A dotted key is an
 * import's exported instance, two levels deep, as for observed state.
 */
export function applyReadingNode(
  properties: Record<string, any>,
  key: string,
  reading: Record<string, any>,
): void {
  const dot = key.indexOf(".");
  if (dot < 0) {
    properties[key] = reading;
    return;
  }
  const aliasNode = (properties[key.slice(0, dot)] ??= {
    type: "object",
    additionalProperties: true,
    properties: {},
  });
  (aliasNode.properties ??= {})[key.slice(dot + 1)] = reading;
}

/**
 * Write the typed `status` node for one index key into a `resources` property
 * map. A dotted key (`Alias.name`) is an import's exported instance, which
 * publishes two levels deep — the alias node stays open so every other name
 * under it keeps resolving as it does today.
 */
export function applyObservedStateNode(
  properties: Record<string, any>,
  key: string,
  status: Record<string, any>,
): void {
  const dot = key.indexOf(".");
  const leaf = {
    type: "object",
    additionalProperties: true,
    properties: { [OBSERVED_STATE_KEY]: { ...status, additionalProperties: false } },
  };
  if (dot < 0) {
    properties[key] = leaf;
    return;
  }
  const alias = key.slice(0, dot);
  const name = key.slice(dot + 1);
  const aliasNode = (properties[alias] ??= {
    type: "object",
    additionalProperties: true,
    properties: {},
  });
  (aliasNode.properties ??= {})[name] = leaf;
}
