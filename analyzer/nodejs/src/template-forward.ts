import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { collectScopeMembers, declareInScopeOf, isScopeMemberDeclaration } from "./scope-members.js";
import { CEL_ENGINE, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { moduleScopedDefResolver, type AliasResolver } from "./alias-resolver.js";
import { relocatePath } from "./choice-expansion.js";
import type { Assignment } from "./configuration-dimensions.js";
import {
  Alternatives,
  EVERYWHERE,
  expandUnion,
  heldNode,
  holdingOf,
  isAlternatives,
  meet,
  type AlternativeOption,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Holding,
  type PlaceMap,
  type PlaceMapping,
  viewChainOf,
} from "./conditioned-expansion.js";
import { declarationOf, resolveReferenceOutcome, type NameResolution } from "./reference-resolution.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { celEvalModeAt, kindCelEvalSites, NO_CEL_EVAL_SITES, type CelEvalSites } from "./eval-paths.js";
import {
  controllerBearingAncestor,
  hasOwnControllerOrTemplate,
  type DefResolver,
} from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import { referenceValueOf } from "./peer-binding.js";
import { cloneForMutation, normalizeInlineResources } from "./normalize-inline-resources.js";
import { ConditionSpace, FALSE, TRUE } from "./presence-condition.js";
import { quotedPlacesOf, relocatedRendering, rerootedQuotes, type QuotedPlace } from "./quoted-place.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { rewriteSyntheticOrigins } from "./rewrite-synthetic-origins.js";
import type { ScopeSite } from "./scope-address.js";
import { declaringScopeOf } from "./scope-members.js";
import { isConsumerForward, parseKeys, type ConsumerForward } from "./template-expansion.js";
import { SELF_PATH } from "./template-self-forward.js";
import type { AnalysisDiagnostic } from "./types.js";

/**
 * A VALUE A TEMPLATE BODY FORWARDS IS CHECKED AS THE ENTRY KIND'S OWN FIELD.
 *
 * A `resources:` entry holding a bare `!cel "self.<path>"` receives the
 * instance's value verbatim — the kernel navigates it, live references and
 * unevaluated CEL included — so what the consumer wrote there is, at boot, a
 * field of a resource of the ENTRY's kind: validated against its schema, its
 * reference slots injected, its expressions evaluated in its contexts. Only the
 * enclosing kind's own `schema:` used to be checked, so a route forwarded into a
 * router passed `telo check` with a status that is not an integer and failed at
 * boot with the router's own `ERR_INVALID_VALUE`.
 *
 * Each such consumer gets a VIEW: a resource of the entry's kind holding exactly
 * the forwarded values, added to the analysis beside the manifests so the whole
 * per-resource pipeline — schema, `x-telo-schema-from`, reference slots and their
 * `inputs:` pointers, CEL contexts — runs on it unchanged. The view is declared
 * in the CONSUMER's module, because every forwarded value was written there: its
 * references were resolved in the consumer's scope and its CEL is typed against
 * the consumer's globals. Only its kind is the defining module's, written in
 * canonical form so no alias scope is needed to resolve it.
 *
 * ONE builder makes every view ({@link buildForwardViews}): over the union of
 * every configuration it is lifted — each forwarded value enters behind an
 * option node MOVED to where the consumer wrote it, keeping the options a choice
 * gives it in place; a body choice deciding on a read some configurations vary
 * is an option node; a view holds where its consumer and the body options it is
 * built through hold — and over one configuration's declarations (a union of no
 * choice) it is that configuration's ({@link buildTemplateForwardViews}).
 *
 * Where a finding about a view is reported is its projection's PLACE MAP: a
 * path inside a forwarded value moves to where the consumer wrote it, in the
 * consumer's file (`routes[0].returns[0].status` → `workflows[0].returns[0].status`),
 * a message quoting places rendered from where they now stand; a path the map
 * does not move describes the entry's literal content or the view itself, which
 * is the defining module's to check, and is dropped. A forward that also
 * violates a constraint the enclosing kind restates is reported ONCE — the
 * consumer's own diagnostic at that path and code wins.
 *
 * A CEL expression belongs to the one resource that evaluates it. The enclosing
 * kind evaluates a forwarded value only where its own schema marks the path
 * compile-eval (the kernel expands those at `create()`, so the value forwarded is
 * already data); everywhere else the kernel leaves the expression compiled and
 * the entry's controller evaluates it. So the consumer's check at a forwarded
 * path defers to the view, and the view skips what its consumer evaluates.
 *
 * Views are built for the entry's own modules' declarations only, like every
 * other declaration check — one written inside another, inline or as a scope
 * member, included, reported where it is written there — and nest: an entry
 * whose kind is itself templated is a consumer in turn. Browser-safe.
 */

type Segment = string | number;

/** The option taken at one depth of a forward's place, where a lifted body
 *  choice decides it. */
export interface ForwardRoute {
  readonly depth: number;
  readonly index: number;
}

/** One forward inside a template body entry. */
export interface TemplateForward {
  /** Where it sits in the entry (`routes`, `openapi.info.title`, `mounts[0].mount`). */
  readonly at: readonly Segment[];
  /** The `self` path it forwards (`["workflows"]`). */
  readonly self: readonly string[];
  /** A loop binding's forward, as one consumer's expansion resolved it: what
   *  the consumer wrote at these keys. */
  readonly consumer?: ConsumerForward["__templateForward"];
  /** The options of a lifted body taken on the way, outermost first. */
  readonly route: readonly ForwardRoute[];
}

/** The `self` path a value forwards verbatim, in any spelling a `!cel` arrives
 *  in, or undefined when it is anything else. The pattern is the kernel's. */
export function selfForwardPath(value: unknown): string[] | undefined {
  const source = celSource(value);
  if (source === undefined) return undefined;
  const match = SELF_PATH.exec(source.trim());
  return match ? match[1]!.split(".").slice(1) : undefined;
}

/** Every bare `self.<path>` forward in a body entry, outside its `kind` and
 *  `metadata`. A forward is a leaf: nothing below one is written. A place a
 *  lifted body choice decides is read in each of its options. */
export function templateForwardsOf(entry: unknown): TemplateForward[] {
  const out: TemplateForward[] = [];
  const visit = (value: unknown, at: Segment[], route: ForwardRoute[]): void => {
    if (isAlternatives(value)) {
      value.options.forEach((option, index) => {
        if (option.present) visit(option.value, at, [...route, { depth: at.length, index }]);
      });
      return;
    }
    if (at.length > 0 && isConsumerForward(value)) {
      out.push({ at, self: [], consumer: value.__templateForward, route });
      return;
    }
    const self = at.length > 0 ? selfForwardPath(value) : undefined;
    if (self) {
      out.push({ at, self, route });
      return;
    }
    if (isOpaque(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...at, i], route));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (at.length === 0 && (key === "kind" || key === "metadata")) continue;
      visit(child, [...at, key], route);
    }
  };
  visit(entry, [], []);
  return out;
}

/** `["routes", 0, "returns"]` → `routes[0].returns` — the spelling CEL sites,
 *  schema issues and position lookups share. */
export function formatPath(segments: readonly Segment[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${segment}` : segment;
  }
  return out;
}

/** One view of a configuration's analysis, as the analysis holds it. */
interface ForwardedEntry {
  readonly view: ResourceManifest;
  readonly entryKind: string;
  readonly entryName: string;
  /** The declaration whose value this view holds — the consumer, or a view one
   *  template further out. */
  readonly upstream: ResourceManifest;
  /** Into `upstream`'s paths. */
  readonly links: readonly ForwardLink[];
  /** The consumer a diagnostic is reported at, as the analysis names it. */
  readonly root: ResourceManifest;
  /** Where each of the view's places is written in its root's document. */
  readonly places: PlaceMap;
  /** The identity a finding is reported under, where it is not the root's
   *  own: a whole document a tag declares is reported under the tag. */
  readonly reportedAs?: { readonly kind: string; readonly name: string };
  /** Where the root's projected positions are written, where a forward's place
   *  is written rather than projected: a message names a forwarded place as it
   *  stands in the root. */
  readonly rootPlaces?: PlaceMap;
}

/** The views a configuration's analysis carries, and the questions asked of
 *  them. */
export class TemplateForwardViews {
  /** Every view. */
  readonly manifests: ResourceManifest[] = [];
  /** What the views' own slots extracted — a view's diagnostics reach it
   *  through `xTeloOrigin`, like any extraction's. */
  readonly extractions: ResourceManifest[] = [];
  private readonly byView = new Map<ResourceManifest, ForwardedEntry>();
  private readonly byName = new Map<string, ForwardedEntry>();
  private readonly outgoing = new Map<ResourceManifest, ForwardedEntry[]>();
  private readonly sites = new Map<ResourceManifest, CelEvalSites>();
  /** Each holder with a view, and the definition whose body it expands — its
   *  own, or the controller-bearing ancestor's it runs. */
  private readonly runners = new Map<ResourceManifest, ResourceDefinition>();

  /** Everything to analyze beside the manifests the views were built from. */
  get analyzed(): ResourceManifest[] {
    return [...this.manifests, ...this.extractions];
  }

  addHolder(manifest: ResourceManifest, sites: CelEvalSites): void {
    this.sites.set(manifest, sites);
  }

  addRunner(holder: ResourceManifest, runner: ResourceDefinition): void {
    this.runners.set(holder, runner);
  }

  /** Every declaration a view was built for, with the definition whose body
   *  holds the entries it forwards into. */
  holders(): IterableIterator<[ResourceManifest, ResourceDefinition]> {
    return this.runners.entries();
  }

  /** Each view with the consumer its diagnostics are reported at. */
  consumers(): Array<readonly [ResourceManifest, ResourceManifest]> {
    return [...this.byView].map(([view, entry]) => [view, entry.root] as const);
  }

  /** The view of the body entry named `entryName` that `holder` forwards into. */
  viewFor(holder: ResourceManifest, entryName: string): ResourceManifest | undefined {
    return this.outgoing.get(holder)?.find((entry) => entry.entryName === entryName)?.view;
  }

  /** True when the value a view holds at `path` was evaluated before it was
   *  forwarded: a consumer up the chain marks the path it came from
   *  compile-eval, so the entry receives the result. */
  evaluatedBefore(view: ResourceManifest, path: string): boolean {
    const entry = this.byView.get(view);
    return entry ? this.evaluatedUpstream(entry, path) : false;
  }

  addEntry(entry: ForwardedEntry): void {
    this.manifests.push(entry.view);
    this.byView.set(entry.view, entry);
    this.byName.set(entry.view.metadata!.name as string, entry);
    const list = this.outgoing.get(entry.upstream);
    if (list) list.push(entry);
    else this.outgoing.set(entry.upstream, [entry]);
  }

  /**
   * Whether the CEL at `path` on `manifest` is checked by another resource: a
   * value `manifest`'s kind forwards without evaluating (the entry evaluates it),
   * or a value a view holds that its consumer already evaluated at compile time.
   */
  defersCel(manifest: ResourceManifest, path: string): boolean {
    const forwards = this.outgoing.get(manifest);
    if (
      forwards?.some((entry) => entry.links.some((link) => covers(link.from, path))) &&
      celEvalModeAt(this.sitesOf(manifest), path) !== "compile"
    ) {
      return true;
    }
    const entry = this.byView.get(manifest);
    return entry ? this.evaluatedUpstream(entry, path) : false;
  }

  private evaluatedUpstream(entry: ForwardedEntry, path: string): boolean {
    const link = entry.links.find((l) => covers(l.at, path));
    if (!link) return false;
    const upstreamPath = link.from + path.slice(link.at.length);
    if (celEvalModeAt(this.sitesOf(entry.upstream), upstreamPath) === "compile") return true;
    const outer = this.byView.get(entry.upstream);
    return outer ? this.evaluatedUpstream(outer, upstreamPath) : false;
  }

  private sitesOf(manifest: ResourceManifest): CelEvalSites {
    return this.sites.get(manifest) ?? NO_CEL_EVAL_SITES;
  }

  /**
   * `diagnostics` with every one about a view placed by the view's place map,
   * or dropped.
   *
   * `diagnostics` are as the passes wrote them, each naming the declaration it
   * is about: one about a view's extraction is first moved onto the view. A
   * path the place map does not move is the entry's literal content or the
   * view's own identity, which is the defining module's concern, and is dropped
   * first; every other one is relocated to where its consumer wrote it, a
   * message quoting places rendered from where they now stand. What is moved
   * names the consumer as the passes name it — an extraction, a scope member —
   * so the caller reroutes it with every other diagnostic. A forwarded
   * diagnostic the consumer's own analysis already makes — same code, same path
   * — is dropped, so a constraint the enclosing kind restates is reported once.
   */
  placed(diagnostics: AnalysisDiagnostic[]): AnalysisDiagnostic[] {
    if (this.byName.size === 0) return diagnostics;
    const own: AnalysisDiagnostic[] = [];
    const found: AnalysisDiagnostic[] = [];
    const links: { entry: ForwardedEntry; link: PlaceMapping }[] = [];
    // Placement climbs one origin chain, innermost first: what extraction drew
    // out of a view is unfolded onto the view and its quotes re-rooted there,
    // and only then does the view's place map move it to its consumer.
    for (const d of rerootedQuotes(rewriteSyntheticOrigins(diagnostics, this.analyzed))) {
      const entry = this.entryOf(d);
      if (!entry) {
        own.push(d);
        continue;
      }
      const link = forwardPointOf(entry.places, pathOf(d));
      if (!link) continue;
      found.push(d);
      links.push({ entry, link });
    }
    const relocated = relocatedRendering(found, (list) =>
      list.map((d) => {
        const entry = this.entryOf(d);
        if (!entry) return d;
        const data = d.data as { path?: unknown; filePath?: string };
        const root = entry.root;
        return {
          ...d,
          data: {
            ...data,
            resource: entry.reportedAs ?? { kind: root.kind, name: root.metadata?.name as string },
            filePath: (root.metadata as { source?: string } | undefined)?.source ?? data.filePath,
            // Which view of its consumer a relation instance marker stands in.
            ...("relationGroup" in data ? { forwardedFrom: viewChainOf(entry.view, root) } : {}),
            ...(typeof data.path === "string" ? { path: relocatePath(data.path, entry.places.mappings) } : {}),
          },
        } as AnalysisDiagnostic;
      }),
    );
    const moved = relocated.map((d, i) => {
      const { entry, link } = links[i]!;
      return forwardedMessage(d, entry, entry.rootPlaces ? { ...link, to: projectedPlace(link.to, entry.rootPlaces) } : link);
    });
    return [...own, ...withoutForwardedDuplicates(own, moved)];
  }

  private entryOf(d: AnalysisDiagnostic): ForwardedEntry | undefined {
    const name = (d.data as { resource?: { name?: unknown } } | undefined)?.resource?.name;
    return typeof name === "string" ? this.byName.get(name) : undefined;
  }
}

/** Where the written place `written` stands in the projection `places` maps
 *  back: through the mapping writing the longest part of it. */
function projectedPlace(written: readonly Segment[], places: PlaceMap): readonly Segment[] {
  let best: PlaceMapping | undefined;
  for (const mapping of places.mappings) {
    if (mapping.to.length > written.length || !mapping.to.every((key, i) => String(key) === String(written[i]))) continue;
    if (!best || mapping.to.length > best.to.length) best = mapping;
  }
  return best ? [...best.from, ...written.slice(best.to.length)] : written;
}

function pathOf(d: AnalysisDiagnostic): string {
  const path = (d.data as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : "";
}

/** The forward a place map moves `path` with: the outermost moved place at or
 *  above it, or undefined when nothing moves it. */
function forwardPointOf(places: PlaceMap, path: string): PlaceMapping | undefined {
  const keys = parseKeys(path);
  let match: PlaceMapping | undefined;
  for (const mapping of places.mappings) {
    if (mapping.from.length > keys.length || !mapping.from.every((key, i) => String(key) === String(keys[i]))) continue;
    if (!match || mapping.from.length < match.from.length) match = mapping;
  }
  return match;
}

/** A finding about a view, as its consumer reads it: what the consumer wrote,
 *  where it is forwarded, and what the entry's check found there. */
function forwardedMessage(d: AnalysisDiagnostic, entry: ForwardedEntry, link: PlaceMapping): AnalysisDiagnostic {
  const viewLabel = `${entry.view.kind}/${entry.view.metadata!.name as string}`;
  const entryLabel = `the ${entry.entryKind} entry '${entry.entryName}'`;
  // A consumer written inline is named by the declaration holding it; a scope
  // member is a declaration its author named.
  const reported =
    (isScopeMemberDeclaration(entry.root) ? undefined : entry.reportedAs) ?? { kind: entry.root.kind, name: entry.root.metadata?.name as string };
  const prefix =
    `${reported.kind}/${reported.name}: '${formatPath(link.to)}' is forwarded into ${entryLabel} as ` +
    `'${formatPath(link.from)}', which checks it as its own field — `;
  const relabel = (text: string, first: boolean) => {
    const inner = first && text.startsWith(`${viewLabel}: `) ? text.slice(viewLabel.length + 2) : text;
    return `${first ? prefix : ""}${inner.split(viewLabel).join(entryLabel)}`;
  };
  const quotes = quotedPlacesOf(d);
  const quotedPlace: QuotedPlace[] | undefined = quotes?.map((q, i) => ({
    ...q,
    before: relabel(q.before, i === 0),
    after: q.after.split(viewLabel).join(entryLabel),
  }));
  return {
    ...d,
    message: relabel(d.message, true),
    ...(quotedPlace ? { data: { ...(d.data as Record<string, unknown>), quotedPlace } } : {}),
  } as AnalysisDiagnostic;
}

/** `moved` — findings about forward views, each at its consumer — less each
 *  one `own` already makes (same code, same place) and each an earlier one of
 *  `moved` makes with the same message. */
export function withoutForwardedDuplicates(
  own: readonly AnalysisDiagnostic[],
  moved: readonly AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  const reported = new Set(own.map(identityKey));
  const out: AnalysisDiagnostic[] = [];
  for (const m of moved) {
    const key = identityKey(m);
    if (reported.has(key) || reported.has(`${key}\0${m.message}`)) continue;
    reported.add(`${key}\0${m.message}`);
    out.push(m);
  }
  return out;
}

function identityKey(d: AnalysisDiagnostic): string {
  const data = d.data as
    | {
        resource?: { kind?: string; name?: string };
        path?: unknown;
        filePath?: string;
        relationGroup?: string;
        forwardedFrom?: string;
        celSite?: string;
        occurrence?: number;
        ownOrigin?: string;
        ownGroup?: string;
      }
    | undefined;
  // A site marker stands for a verdict judged elsewhere: markers at one place
  // are alike only when they name the same site.
  return [
    d.code,
    data?.resource?.kind ?? "",
    data?.resource?.name ?? "",
    data?.filePath ?? "",
    typeof data?.path === "string" ? data.path : "",
    data?.relationGroup ?? "",
    data?.forwardedFrom ?? "",
    data?.celSite ?? "",
    data?.occurrence ?? "",
    data?.ownOrigin ?? "",
    data?.ownGroup ?? "",
  ].join("\0");
}

/** The space of one configuration: no dimension, every holding everywhere. */
const ONE_CONFIGURATION = new ConditionSpace([]);

/**
 * The views of one configuration's declarations — `manifests`, whose
 * references are already resolved (after Phase 2.5), so a view holds exactly
 * what the kernel forwards: {@link buildForwardViews} over them as a union of no
 * choice, each view projected, normalized and placed by its place map.
 */
export function buildTemplateForwardViews(
  /** The declarations whose forwards are viewed. */
  manifests: readonly ResourceManifest[],
  /** What a reference a crossing reads through resolves to. */
  names: NameResolution,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: ReadonlySet<string> },
  /** The body a consumer's kind runs, as that consumer expands it — a body
   *  holding an expansion construct; absent, the body as written. */
  bodyOf?: (consumer: ResourceManifest) => ResourceManifest | undefined,
): TemplateForwardViews {
  const union = expandUnion([], ONE_CONFIGURATION, new Map());
  const taken = new Set<string>();
  for (const m of manifests) if (typeof m.metadata?.name === "string") taken.add(m.metadata.name);
  const built = buildForwardViews({
    union,
    consumers: manifests.map((manifest) => ({ condition: TRUE, manifest, holder: manifest, at: [], path: [] })),
    crossing: resolvedCrossing(names, registry, aliases, scopes.aliasesByModule),
    registry,
    aliases,
    scopes,
    ...(bodyOf ? { bodyOf } : {}),
    taken,
  });
  const views = new TemplateForwardViews();
  // A view built from a view is analysed beside the one it was built from.
  const settled = new Map<ResourceManifest, ResourceManifest>();
  for (const view of built.views) {
    const projected = union.project(view.manifest, {});
    const root = view.root.manifest;
    // An inline declaration the consumer's kind declares no slot for reaches
    // the view unextracted; the entry's slot extracts it, as a resource of
    // its own kind, exactly as it would for a top-level declaration.
    const [normalized, ...extracted] = normalizeInlineResources(
      [cloneForMutation(projected.value) as ResourceManifest],
      registry,
      aliases,
      scopes.aliasesByModule,
    );
    settled.set(view.manifest, normalized!);
    for (const declared of [normalized!, ...extracted]) declareInScopeOf(declared, root);
    views.extractions.push(...extracted);
    views.addEntry({
      view: normalized!,
      entryKind: view.entryKind,
      entryName: view.entryName,
      upstream: settled.get(view.upstream) ?? view.upstream,
      links: view.links,
      root,
      places: projected.places,
    });
  }
  for (const [manifest, sites] of built.sites) views.addHolder(settled.get(manifest) ?? manifest, sites);
  for (const [holder, runner] of built.runners) views.addRunner(settled.get(holder) ?? holder, runner);
  return views;
}

/** A declaration the configuration runs analyse beneath one of `declarations`:
 *  an inline one at any depth, extracted, or a scope member — where it is
 *  written in that declaration, and the name the run gives it. */
export interface NestedDeclaration {
  /** The index of the declaration holding it. */
  readonly top: number;
  /** Its keys in that declaration, as given. */
  readonly keys: readonly Segment[];
  readonly name: string;
  /** The scope the run declares it in: where its names resolve first. */
  readonly scope: ScopeSite | undefined;
  /** How the run comes to analyse it: drawn out by inline normalization, its
   *  place left holding a reference, or a scope member left in place. */
  readonly via: "extraction" | "scope";
}

/**
 * Every declaration a configuration run analyses beneath `declarations` (one
 * configuration's, as expanded): what inline normalization extracts, at any
 * depth, and every scope member — each unfolded, innermost first, through its
 * extraction origin and its scope membership to where it is written in the
 * declaration holding it. The runs' own enumeration, read so a lifted reading
 * of the same declarations can be held to it.
 */
export function nestedDeclarationsOf(
  declarations: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): NestedDeclaration[] {
  const normalized = normalizeInlineResources([...declarations], registry, aliases, aliasesByModule);
  const members = collectScopeMembers(normalized, (d) => registry.referenceSites(d, aliases, aliasesByModule)).analysed;
  const memberOf = new Map(members.map((member) => [member.declaration, member] as const));
  const all = [...normalized, ...members.map((member) => member.declaration)];
  const named = new Map<string, ResourceManifest>();
  const identity = (kind: unknown, name: unknown, module: unknown) => JSON.stringify([kind, name, module ?? null]);
  for (const m of all) named.set(identity(m.kind, m.metadata?.name, moduleOf(m)), m);
  const landings = new Map<ResourceManifest, { top: number; keys: readonly Segment[] } | undefined>();
  const landing = (m: ResourceManifest): { top: number; keys: readonly Segment[] } | undefined => {
    if (landings.has(m)) return landings.get(m);
    landings.set(m, undefined);
    let found: { top: number; keys: readonly Segment[] } | undefined;
    const top = normalized.indexOf(m);
    const origin = (m.metadata as { xTeloOrigin?: { parentKind: string; parentName: string; pathFromParent: string; keysFromParent?: Segment[] } } | undefined)
      ?.xTeloOrigin;
    const member = memberOf.get(m);
    if (top >= 0 && top < declarations.length && !origin) {
      found = { top, keys: [] };
    } else if (origin) {
      const parent = named.get(identity(origin.parentKind, origin.parentName, moduleOf(m)));
      const at = parent && landing(parent);
      if (at) found = { top: at.top, keys: [...at.keys, ...(origin.keysFromParent ?? parseKeys(origin.pathFromParent))] };
    } else if (member) {
      const at = landing(member.holder);
      if (at) found = { top: at.top, keys: [...at.keys, ...member.scope.keys, member.scope.declarations.indexOf(m)] };
    }
    landings.set(m, found);
    return found;
  };
  const out: NestedDeclaration[] = [];
  for (const m of all) {
    const at = landing(m);
    if (!at || at.keys.length === 0 || typeof m.metadata?.name !== "string") continue;
    out.push({ ...at, name: m.metadata.name, scope: declaringScopeOf(m), via: memberOf.has(m) ? "scope" : "extraction" });
  }
  return out;
}

/** A value of the union written beneath one of its declarations that a
 *  configuration run may analyse as a consumer of its own. */
export interface NestedCandidate {
  readonly declaration: ConditionedDeclaration;
  readonly value: Record<string, unknown>;
  /** Where it is written in the declaration's holder. */
  readonly written: readonly Segment[];
  /** Its union keys in the declaration, choices transparent. */
  readonly unionKeys: readonly Segment[];
  readonly holding: Holding;
  /** For one only a branch no configuration takes holds: the branch and a
   *  configuration reaching its choice. */
  readonly dead?: { readonly sentinel: object; readonly branch: string | null | undefined; readonly baseline: Assignment };
}

/**
 * Every object written beneath a declaration of the union, at any depth and in
 * every option, whose kind runs a template body of the entry's own modules —
 * each where it is written in the declaration's holder, under the declaration's
 * holding AND the options on the way to it. Which of them a run analyses as a
 * declaration is the run's to say; this only finds where to ask.
 */
export function nestedCandidatesOf(
  union: ConditionedExpansion,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: ReadonlySet<string> },
): NestedCandidate[] {
  const { space } = union;
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const out: NestedCandidate[] = [];
  for (const declaration of union.declarations) {
    const m = declaration.manifest;
    if (!isConsumer(m, scopes.rootModules)) continue;
    const runsTemplate = (kind: string): boolean => {
      const definition = definitionInScope<ResourceDefinition>(registry, kind, m.metadata, aliases, scopes.aliasesByModule);
      return definition?.kind === "Telo.Definition" && templateRunnerOf(definition, resolveDef) !== undefined;
    };
    const visit = (
      value: unknown,
      written: readonly Segment[],
      unionKeys: readonly Segment[],
      holding: Holding,
      dead: NestedCandidate["dead"],
      root: boolean,
    ): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          if (!option.present) continue;
          const step = option.path.at(-1);
          const deadHere =
            dead ??
            (option.unreachable && option.baseline && step
              ? { sentinel: step.sentinel, branch: step.branch, baseline: option.baseline }
              : undefined);
          visit(option.value, option.at, unionKeys, meet(space, holding, holdingOf(option)), deadHere, root);
        }
        return;
      }
      if (!isPlainContainer(value)) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...written, i], [...unionKeys, i], holding, dead, false));
        return;
      }
      const record = value as Record<string, unknown>;
      if (!root && typeof record.kind === "string" && runsTemplate(record.kind)) {
        out.push({ declaration, value: record, written, unionKeys, holding, ...(dead ? { dead } : {}) });
      }
      for (const [key, field] of Object.entries(record)) {
        if (root && (key === "kind" || key === "metadata")) continue;
        visit(field, [...written, key], [...unionKeys, key], holding, dead, false);
      }
    };
    visit(m, declaration.at, [], { condition: declaration.condition, path: declaration.path }, undefined, true);
  }
  return out;
}

/** A nested declaration as a consumer the view builder reads: its value as
 *  written, under the name the runs give it, declared in the module of the
 *  declaration holding it. */
export function nestedConsumerManifest(value: Record<string, unknown>, holding: ResourceManifest, name: string): ResourceManifest {
  const holderMeta = { ...(holding.metadata as Record<string, unknown>) };
  delete holderMeta.xTeloOrigin;
  delete holderMeta.xTeloInvocationContext;
  delete holderMeta.xTeloChoice;
  const own = value.metadata && typeof value.metadata === "object" ? (value.metadata as Record<string, unknown>) : {};
  return { ...value, metadata: { ...holderMeta, ...own, name } } as unknown as ResourceManifest;
}

/**
 * The placement of views a key holds as regions of the union, each normalized
 * on its own: a finding about one is placed by the place map of the view's
 * projection and reported at its consumer, or dropped where the map moves
 * nothing.
 */
export function placedViews(
  entries: readonly {
    /** The view as normalized, then what extraction drew out of it. */
    readonly manifests: readonly ResourceManifest[];
    readonly entryKind: string;
    readonly entryName: string;
    readonly root: ResourceManifest;
    readonly reportedAs?: { readonly kind: string; readonly name: string };
    readonly places: PlaceMap;
    readonly rootPlaces: PlaceMap;
  }[],
): TemplateForwardViews {
  const views = new TemplateForwardViews();
  for (const entry of entries) {
    const [view, ...drawn] = entry.manifests;
    views.extractions.push(...drawn);
    views.addEntry({
      view: view!,
      entryKind: entry.entryKind,
      entryName: entry.entryName,
      upstream: entry.root,
      links: [],
      root: entry.root,
      places: entry.places,
      rootPlaces: entry.rootPlaces,
      ...(entry.reportedAs ? { reportedAs: entry.reportedAs } : {}),
    });
  }
  return views;
}

/** A configuration's references: resolved, each naming one declaration. */
function resolvedCrossing(
  names: NameResolution,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
): ForwardCrossing {
  const siteSets = new WeakMap<ResourceManifest, Set<string>>();
  return {
    isSite: (holder, keys) => {
      let sites = siteSets.get(holder);
      if (!sites) {
        const scope = moduleAliasScope(holder.metadata, aliases, aliasesByModule);
        sites = new Set(
          registry
            .referenceSites(holder, scope, aliasesByModule)
            .filter((site) => site.refs.length > 0)
            .map((site) => site.path),
        );
        siteSets.set(holder, sites);
      }
      return sites.has(formatPath(keys));
    },
    targets: (value, holder) => {
      const reference = referenceValueOf(value);
      if (!reference) return undefined;
      const scope = moduleAliasScope(holder.metadata, aliases, aliasesByModule);
      // A scope member's own fields read its scope's names first.
      const declaration = declarationOf(
        resolveReferenceOutcome(
          names,
          reference,
          moduleOf(holder),
          (alias) => scope?.moduleForAlias(alias),
          declaringScopeOf(holder),
          holder,
        ),
      );
      return [{ declaration, holding: EVERYWHERE }];
    },
  };
}

/** True when `path` is `prefix` or lies below it. */
function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** A node the view holds at `at` is what its upstream declaration wrote at
 *  `from` — the CEL deferral reads these, in the upstream's own paths. */
interface ForwardLink {
  readonly at: string;
  readonly from: string;
}

/** A reference a forward read across: where it stands in the declaration
 *  holding it (a choice node transparent), and the path read on in each
 *  declaration it names. */
export interface ForwardCrossed {
  readonly holder: ResourceManifest;
  readonly at: readonly Segment[];
  readonly rest: readonly Segment[];
}

/** One view as the builder made it. */
export interface BuiltView {
  /** The view — over every configuration at once, every value a consumer
   *  wrote that a choice decides an option node; the forwarded values behind
   *  option nodes MOVED to where the consumer wrote them, so a projection's
   *  place map is where each finding is reported. */
  readonly manifest: ResourceManifest;
  /** Where it holds: its consumer's holding AND the body options it is built
   *  through. */
  readonly holding: Holding;
  /** The declaration of the input whose values it holds — a view built from a
   *  view holds its root consumer's. */
  readonly root: ConditionedDeclaration;
  /** The declaration this view was built from: the root, or a view. */
  readonly upstream: ResourceManifest;
  readonly entryKind: string;
  readonly entryName: string;
  /** Into `upstream`'s paths. */
  readonly links: readonly ForwardLink[];
  /** Every reference its forwards read across. */
  readonly crossed: readonly ForwardCrossed[];
  readonly definition: ResourceDefinition;
}

/** What one build read and made. */
export interface BuiltViews {
  readonly views: readonly BuiltView[];
  /** Each holder with a view, and the definition whose body it expands. */
  readonly runners: ReadonlyMap<ResourceManifest, ResourceDefinition>;
  /** Where each holder's own kind evaluates CEL. */
  readonly sites: ReadonlyMap<ResourceManifest, CelEvalSites>;
}

/** What decides where a declaration holds a reference, and what one names. */
export interface ForwardCrossing {
  /** Whether `keys` of `holder` is one of its reference sites where `holding`
   *  holds. */
  isSite(holder: ResourceManifest, keys: readonly Segment[], holding: Holding): boolean;
  /** Every declaration the reference `value` names, read by `holder`, each
   *  where it names it, with the module declaring it where its own metadata
   *  does not say (a scope member as written, its scope holder's); undefined
   *  when `value` is no reference. */
  targets(
    value: unknown,
    holder: ResourceManifest,
    holding: Holding,
  ):
    | readonly { readonly declaration: ResourceManifest | undefined; readonly holding: Holding; readonly module?: string }[]
    | undefined;
}

/** What the one view builder reads: the declarations whose forwards are
 *  viewed, in the union holding them — a projection of each view is read
 *  through it. A configuration's own declarations are a union of no choice. */
export interface ForwardViewInput {
  readonly union: ConditionedExpansion;
  readonly consumers: readonly ConditionedDeclaration[];
  readonly crossing: ForwardCrossing;
  readonly registry: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: ReadonlySet<string> };
  /** The body a consumer's kind runs, as that consumer expands it — a body
   *  holding an expansion construct; absent, the body as written. */
  readonly bodyOf?: (consumer: ResourceManifest) => ResourceManifest | undefined;
  /** Names a view may not take. */
  readonly taken: ReadonlySet<string>;
}

/** A declaration a view is built for, and where its value came from. */
interface Holder {
  readonly manifest: ResourceManifest;
  readonly definition: ResourceDefinition;
  readonly root: ConditionedDeclaration;
  readonly holding: Holding;
  /** True for a view built from a view: its moved values carry their root
   *  consumer's places, everything else is written nowhere. */
  readonly isView: boolean;
  /** The templated definitions already expanded above this one — a body whose
   *  entry is a kind on this chain would expand forever. */
  readonly chain: ReadonlySet<ResourceDefinition>;
}

/** A forwarded value placed in a view: its node, and the links into its
 *  upstream's own paths. */
interface Sourced {
  readonly node: Alternatives;
  readonly links: readonly { at: Segment[]; from: Segment[] }[];
  readonly crossed?: readonly ForwardCrossed[];
}

/**
 * THE view builder: the views of every forward made by `input.consumers`,
 * nested templates included. Over a union of every configuration it is lifted
 * — a forwarded value keeps its options in place behind a node moved to where
 * the consumer wrote it, a body choice deciding on a read some configurations
 * vary is an option node, and a view holds where its consumer and the body
 * options it is built through hold; over one configuration's declarations
 * (a union of no choice) the same build is that configuration's.
 */
export function buildForwardViews(input: ForwardViewInput): BuiltViews {
  const { union, registry, aliases, scopes } = input;
  const { space } = union;
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const views: BuiltView[] = [];
  const runners = new Map<ResourceManifest, ResourceDefinition>();
  const sites = new Map<ResourceManifest, CelEvalSites>();
  const named = new Map<string, Holding[]>();
  /** A view's name: its holder's, then its entry's — numbered where a view
   *  holding together with it already took the name. */
  const nameFor = (base: string, holding: Holding): string => {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}#${n}`;
      if (input.taken.has(name)) continue;
      const users = named.get(name) ?? [];
      if (users.some((other) => space.and(other.condition, holding.condition) !== FALSE)) continue;
      named.set(name, [...users, holding]);
      return name;
    }
  };

  const queue: Holder[] = [];
  for (const consumer of input.consumers) {
    const m = consumer.manifest;
    if (!isConsumer(m, scopes.rootModules)) continue;
    const definition = definitionInScope<ResourceDefinition>(registry, m.kind, m.metadata, aliases, scopes.aliasesByModule);
    if (!definition || definition.kind !== "Telo.Definition") continue;
    queue.push({
      manifest: m,
      definition,
      root: consumer,
      holding: { condition: consumer.condition, path: consumer.path },
      isView: false,
      chain: new Set([definition]),
    });
  }

  for (let i = 0; i < queue.length; i++) {
    const holder = queue[i]!;
    const runner = templateRunnerOf(holder.definition, resolveDef);
    if (!runner) continue;
    const body = holder.isView ? undefined : input.bodyOf?.(holder.manifest);
    const entries = forwardedEntries(holder, runner, input, body);
    if (entries.length === 0) continue;
    runners.set(holder.manifest, runner);
    sites.set(holder.manifest, kindCelEvalSites(holder.definition, resolveDef, registry.shapeLookup));
    for (const entry of entries) {
      const holding = meet(space, holder.holding, entry.holding);
      if (holding.condition === FALSE && !holder.root.unreachable) continue;
      const name = nameFor(`${holder.manifest.metadata!.name as string}→${entry.name}`, holding);
      const view = { ...entry.body, metadata: viewMetadata(holder.root.manifest, name) } as unknown as ResourceManifest;
      union.hold(view as unknown as object);
      views.push({
        manifest: view,
        holding,
        root: holder.root,
        upstream: holder.manifest,
        entryKind: entry.writtenKind,
        entryName: entry.name,
        links: entry.links,
        crossed: entry.crossed,
        definition: entry.definition,
      });
      sites.set(view, kindCelEvalSites(entry.definition, resolveDef, registry.shapeLookup));
      if (!holder.chain.has(entry.definition)) {
        queue.push({
          manifest: view,
          definition: entry.definition,
          root: holder.root,
          holding,
          isView: true,
          chain: new Set([...holder.chain, entry.definition]),
        });
      }
    }
  }
  return { views, runners, sites };
}

/** A resource of the entry's own modules, as the per-resource checks select one. */
function isConsumer(m: ResourceManifest, rootModules: ReadonlySet<string>): boolean {
  if (typeof m.kind !== "string" || typeof m.metadata?.name !== "string") return false;
  if (isModuleKind(m.kind) || m.kind.startsWith("Telo.")) return false;
  if (isForwardedDeclaration(m) || isInjectedDeclaration(m)) return false;
  const module = (m.metadata as { module?: unknown }).module;
  return typeof module !== "string" || rootModules.has(module);
}

interface BuiltEntry {
  readonly body: Record<string, unknown>;
  readonly definition: ResourceDefinition;
  readonly writtenKind: string;
  readonly name: string;
  readonly links: ForwardLink[];
  readonly crossed: ForwardCrossed[];
  /** Where the body declares the entry. */
  readonly holding: Holding;
}

/** The definition whose body an instance of `definition` runs: its own, or —
 *  for an `extends` child with no body of its own — its controller-bearing
 *  ancestor's, handed its own config or, with `base:`, the mapping over it. */
function templateRunnerOf(
  definition: ResourceDefinition,
  resolveDef: DefResolver,
): ResourceDefinition | undefined {
  return hasOwnControllerOrTemplate(definition)
    ? definition
    : controllerBearingAncestor(definition, resolveDef);
}

/** Every `resources:` entry of `body`, each where the body declares it: an
 *  entry a lifted choice decides is one per option. */
function bodyEntriesOf(body: ResourceManifest, space: ConditionSpace): { manifest: ResourceManifest; index: number; holding: Holding }[] {
  if (body.kind !== "Telo.Definition") return [];
  const resources = (body as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) return [];
  const out: { manifest: ResourceManifest; index: number; holding: Holding }[] = [];
  const visit = (value: unknown, index: number, holding: Holding) => {
    if (isAlternatives(value)) {
      for (const option of value.options) {
        if (option.present) visit(option.value, index, meet(space, holding, holdingOf(option)));
      }
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (typeof (value as { kind?: unknown }).kind !== "string") return;
    out.push({ manifest: value as ResourceManifest, index, holding });
  };
  resources.forEach((value, index) => visit(value, index, EVERYWHERE));
  return out;
}

function forwardedEntries(
  holder: Holder,
  runner: ResourceDefinition,
  input: ForwardViewInput,
  expanded: ResourceManifest | undefined,
): BuiltEntry[] {
  const { registry, aliases, scopes, union } = input;
  const definition = holder.definition;
  const base = runner === definition ? undefined : (definition as { base?: unknown }).base;
  const runnerScope = moduleAliasScope(runner.metadata, aliases, scopes.aliasesByModule);
  const canonicalInRunner = (kind: string): string => runnerScope?.resolveKind(kind) ?? kind;
  const body = expanded ?? (runner as unknown as ResourceManifest);
  // A nested kind is written through the alias scope of the module that
  // declared the definition.
  const bodyScope = moduleAliasScope(body.metadata, aliases, scopes.aliasesByModule);
  const out: BuiltEntry[] = [];
  for (const entry of bodyEntriesOf(body, union.space)) {
    const written = entry.manifest.kind;
    const canonical = bodyScope?.resolveKind(written);
    const entryDefinition = registry.resolve(written) ?? (canonical ? registry.resolve(canonical) : undefined);
    if (!entryDefinition) continue;
    const kind = canonicalKindOf(entryDefinition);
    if (registry.resolve(kind) !== entryDefinition) continue;
    const view: Record<string, unknown> = { kind };
    const links: ForwardLink[] = [];
    const crossed: ForwardCrossed[] = [];
    let placed = false;
    for (const forward of templateForwardsOf(entry.manifest)) {
      const source = forward.consumer
        ? fromConsumer(holder, forward.consumer, union.space)
        : base == null
          ? fromSelf(holder, forward.self, input)
          : throughBase(base, forward.self, holder, input);
      if (!source) continue;
      place(view, entry.manifest, forward.at, forward.route, source.node, canonicalInRunner, union);
      placed = true;
      crossed.push(...(source.crossed ?? []));
      for (const link of source.links) {
        links.push({ at: formatPath([...forward.at, ...link.at]), from: formatPath(link.from) });
      }
    }
    if (!placed) continue;
    const entryName = entry.manifest.metadata?.name;
    out.push({
      body: view,
      definition: entryDefinition,
      writtenKind: written,
      name: typeof entryName === "string" ? entryName : `resources[${entry.index}]`,
      links,
      crossed,
      holding: entry.holding,
    });
  }
  return out;
}

function canonicalKindOf(definition: ResourceDefinition): string {
  const { name, module } = definition.metadata;
  return module ? `${module}.${name}` : name;
}

const moduleOf = (manifest: ResourceManifest): string | undefined => {
  const module = (manifest.metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
};

/** One way a forward reads its holder: what it reaches, where that is
 *  written, and where it holds. */
interface Reached {
  readonly node: unknown;
  /** Where the value is written in the root consumer's document; undefined
   *  for a place written nowhere (a view's own). */
  readonly written: readonly Segment[] | undefined;
  /** Every place inside it is reported at {@link written}. */
  readonly exact: boolean;
  readonly holding: Holding;
}

/** Where `holder`'s own root is written. */
function rootWritten(holder: Holder, union: ConditionedExpansion): readonly Segment[] | undefined {
  return holder.isView ? undefined : [...union.placeOf(holder.manifest).at];
}

/** `reached` as one node moved to where each is written: a value a choice
 *  decides keeps its options, each moved to its own place. */
function forwardNode(reached: readonly Reached[], space: ConditionSpace): Alternatives | undefined {
  const options: AlternativeOption[] = [];
  const add = (r: Reached, value: unknown, holding: Holding, written: readonly Segment[] | undefined, exact: boolean) => {
    if (isAlternatives(value)) {
      for (const option of value.options) {
        if (!option.present) continue;
        const h = meet(space, holding, holdingOf(option));
        if (h.condition === FALSE && holding.condition !== FALSE && !option.unreachable) continue;
        // Beneath a moved option the place is the option's; an exact one
        // keeps reporting at the reference.
        add(r, option.value, h, exact ? written : option.moved ? option.at : written, exact || !!option.exact);
      }
      return;
    }
    if (value === undefined) return;
    options.push({
      condition: holding.condition,
      taken: holding.condition,
      path: holding.path,
      present: true,
      value,
      at: written ?? [],
      moved: written !== undefined,
      ...(exact && written !== undefined ? { exact: true as const } : {}),
      // A branch no configuration takes, kept so a witness forcing it holds it.
      ...(holding.condition === FALSE ? { unreachable: true as const } : {}),
    });
  };
  for (const r of reached) add(r, r.node, r.holding, r.written, r.exact);
  return options.length > 0 ? new Alternatives(options) : undefined;
}

/**
 * `self` is the declaration's own configuration. A path that continues past one
 * of the declaration's reference sites continues in the declaration that site
 * names, as the kernel reads it — only within the consumer's own module, since
 * the view resolves every name it holds there. What is reported about such a
 * value is reported at the reference the consumer wrote.
 */
function fromSelf(holder: Holder, self: readonly string[], input: ForwardViewInput): Sourced | undefined {
  const { union, crossing } = input;
  const { space } = union;
  const reached: Reached[] = [];
  let crossedAt: Segment[] | undefined;
  const crossed = new Map<ResourceManifest, Map<string, ForwardCrossed>>();
  const optionsOf = (
    node: Alternatives,
    written: readonly Segment[] | undefined,
    exact: boolean,
    holding: Holding,
    each: (value: unknown, written: readonly Segment[] | undefined, exact: boolean, holding: Holding) => void,
  ) => {
    for (const option of node.options) {
      if (!option.present) continue;
      const h = meet(space, holding, holdingOf(option));
      if (h.condition === FALSE && holding.condition !== FALSE && !option.unreachable) continue;
      each(option.value, exact ? written : option.moved ? option.at : written, exact || !!option.exact, h);
    }
  };
  /** `node`, at segment `i` of the path, read on. */
  const walk = (
    node: unknown,
    declaration: ResourceManifest,
    within: Segment[],
    i: number,
    written: readonly Segment[] | undefined,
    exact: boolean,
    holding: Holding,
  ): void => {
    if (isAlternatives(node)) {
      optionsOf(node, written, exact, holding, (value, w, e, h) => walk(value, declaration, within, i, w, e, h));
      return;
    }
    if (i === self.length) {
      if (node !== undefined) reached.push({ node, written, exact, holding });
      return;
    }
    if (!isPlainObject(node)) return;
    const segment = self[i]!;
    const next = (node as Record<string, unknown>)[segment];
    const nextWritten = written && !exact ? [...written, segment] : written;
    if (i === self.length - 1) walk(next, declaration, [...within, segment], i + 1, nextWritten, exact, holding);
    else at(next, declaration, [...within, segment], i + 1, nextWritten, exact, holding);
  };
  /** The value at `within` of `declaration` before the path ends: at one of
   *  its reference sites, the path continues in what the site names. */
  const at = (
    node: unknown,
    declaration: ResourceManifest,
    within: Segment[],
    i: number,
    written: readonly Segment[] | undefined,
    exact: boolean,
    holding: Holding,
  ): void => {
    if (isAlternatives(node)) {
      optionsOf(node, written, exact, holding, (value, w, e, h) => at(value, declaration, within, i, w, e, h));
      return;
    }
    const targets = crossing.isSite(declaration, within, holding) ? crossing.targets(node, declaration, holding) : undefined;
    if (!targets) {
      walk(node, declaration, within, i, written, exact, holding);
      return;
    }
    crossedAt ??= self.slice(0, i);
    let byPlace = crossed.get(declaration);
    if (!byPlace) crossed.set(declaration, (byPlace = new Map()));
    byPlace.set(JSON.stringify(within), { holder: declaration, at: [...within], rest: self.slice(i) });
    for (const target of targets) {
      const h = meet(space, holding, target.holding);
      if (h.condition === FALSE && holding.condition !== FALSE) continue;
      const named = target.declaration;
      if (!named || (target.module ?? moduleOf(named)) !== moduleOf(holder.manifest)) continue;
      walk(named, named, [], i, written, true, h);
    }
  };
  walk(holder.manifest, holder.manifest, [], 0, rootWritten(holder, union), false, EVERYWHERE);
  const node = forwardNode(reached, space);
  if (!node) return undefined;
  return {
    node,
    links: [{ at: [], from: crossedAt ?? [...self] }],
    crossed: [...crossed.values()].flatMap((byPlace) => [...byPlace.values()]),
  };
}

/** What a loop binding forwarded: the value the consumer wrote at the element,
 *  reported where it wrote it. A value taken across a reference into another
 *  declaration has no path of the consumer's own, so it makes no view. */
function fromConsumer(
  holder: Holder,
  forward: ConsumerForward["__templateForward"],
  space: ConditionSpace,
): Sourced | undefined {
  if (forward.outcomes) {
    const reached: Reached[] = forward.outcomes
      .filter((o) => o.holder === holder.manifest)
      .map((o) => ({ node: o.value, written: o.written, exact: false, holding: o.holding }));
    const node = forwardNode(reached, space);
    return node && { node, links: [{ at: [], from: [...forward.keys] }] };
  }
  if (forward.holder !== holder.manifest) return undefined;
  let node: unknown = holder.manifest;
  for (const key of forward.keys) {
    if (!node || typeof node !== "object" || isOpaque(node)) return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  if (node === undefined) return undefined;
  const written = holder.isView ? undefined : forward.keys;
  // A list index stays a number, so the consumer's path reads `jobs[0]`.
  const built = forwardNode([{ node, written, exact: false, holding: EVERYWHERE }], space);
  return built && { node: built, links: [{ at: [], from: [...forward.keys] }] };
}

/**
 * `self` is the `base:` mapping evaluated over the declaration. What the mapping
 * forwards verbatim is the consumer's; what it computes is data the consumer did
 * not write at any one place, and its literal content is the defining module's —
 * neither has a consumer path to be reported at, so both stay out of the view.
 */
function throughBase(base: unknown, self: readonly string[], holder: Holder, input: ForwardViewInput): Sourced | undefined {
  const { union } = input;
  let node: unknown = base;
  for (let i = 0; i < self.length; i++) {
    const forwarded = selfForwardPath(node);
    if (forwarded) return fromSelf(holder, [...forwarded, ...self.slice(i)], input);
    if (!isPlainObject(node)) return undefined;
    node = (node as Record<string, unknown>)[self[i]!];
    if (node === undefined) return undefined;
  }
  const forwarded = selfForwardPath(node);
  if (forwarded) return fromSelf(holder, forwarded, input);
  const links: { at: Segment[]; from: Segment[] }[] = [];
  const materialize = (value: unknown, at: Segment[]): unknown => {
    const path = selfForwardPath(value);
    if (path) {
      const reached = reachedPlainly(holder, path, union);
      const forwardedNode = forwardNode(reached, union.space);
      if (!forwardedNode) return undefined;
      links.push({ at, from: path });
      return forwardedNode;
    }
    if (isOpaque(value)) return undefined;
    if (Array.isArray(value)) {
      const items = value.map((item, i) => materialize(item, [...at, i]) ?? {});
      union.hold(items);
      return items;
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const materialized = materialize(child, [...at, key]);
        if (materialized !== undefined) out[key] = materialized;
      }
      union.hold(out);
      return out;
    }
    return value;
  };
  const value = materialize(node, []);
  if (links.length === 0) return undefined;
  return { node: heldNode(value, EVERYWHERE, [], false), links };
}

/** `path` read down `holder` with no reference followed, each way a choice
 *  on the way decides it. */
function reachedPlainly(holder: Holder, path: readonly string[], union: ConditionedExpansion): Reached[] {
  const out: Reached[] = [];
  const walk = (node: unknown, i: number, written: readonly Segment[] | undefined, exact: boolean, holding: Holding) => {
    if (isAlternatives(node)) {
      for (const option of node.options) {
        if (!option.present) continue;
        const h = meet(union.space, holding, holdingOf(option));
        if (h.condition === FALSE && holding.condition !== FALSE && !option.unreachable) continue;
        walk(option.value, i, exact ? written : option.moved ? option.at : written, exact || !!option.exact, h);
      }
      return;
    }
    if (i === path.length) {
      if (node !== undefined) out.push({ node, written, exact, holding });
      return;
    }
    if (!isPlainObject(node)) return;
    walk((node as Record<string, unknown>)[path[i]!], i + 1, written && !exact ? [...written, path[i]!] : written, exact, holding);
  };
  walk(holder.manifest, 0, rootWritten(holder, union), false, EVERYWHERE);
  return out;
}

/**
 * Set `value` at `at` in the view, creating what lies above it. A container on
 * the way that the entry writes as an inline declaration keeps its kind, in
 * canonical form, so the value below it is still checked against that kind. A
 * place a lifted body choice decides (`route`: the option taken at each depth)
 * is an option node in the view too, mirroring the body's; a list gap the body
 * holds such a node at is filled only where the body's item is there.
 */
function place(
  view: Record<string, unknown>,
  entry: unknown,
  at: readonly Segment[],
  route: readonly ForwardRoute[],
  value: unknown,
  canonicalKind: (kind: string) => string,
  union: ConditionedExpansion,
): void {
  union.hold(view);
  type Slot = { get(): unknown; set(value: unknown): void };
  let slot: Slot = { get: () => view, set: () => {} };
  let literal: unknown = entry;
  let r = 0;
  for (let i = 0; i < at.length; i++) {
    const segment = at[i]!;
    const container = slot.get() as Record<string | number, unknown>;
    const parent = literal;
    literal = isPlainContainer(literal) ? (literal as Record<string | number, unknown>)[segment] : undefined;
    slot = {
      get: () => container[segment],
      set: (v) => {
        fillGaps(container, segment, Array.isArray(parent) ? parent : undefined);
        container[segment] = v;
      },
    };
    while (route[r]?.depth === i + 1 && isAlternatives(literal)) {
      const body = literal;
      let node = slot.get();
      if (!isAlternatives(node)) {
        node = new Alternatives(body.options.map((option) => mirrored(option, false, undefined)));
        slot.set(node);
      }
      const option = (node as Alternatives).options[route[r]!.index] as { present: boolean; value?: unknown };
      literal = body.options[route[r]!.index]!.value;
      slot = {
        get: () => (option.present ? option.value : undefined),
        set: (v) => {
          option.present = true;
          option.value = v;
        },
      };
      r++;
    }
    if (i === at.length - 1) {
      slot.set(value);
      return;
    }
    const child = slot.get();
    if (!child || typeof child !== "object") slot.set(containerFor(at[i + 1]!, literal, canonicalKind, union));
  }
}

/** A body option as the view mirrors it: where it holds, holding `value`, its
 *  place no place of the consumer's. */
function mirrored(option: AlternativeOption, present: boolean, value: unknown): AlternativeOption {
  return {
    condition: option.condition,
    taken: option.taken,
    path: option.path,
    present,
    ...(present ? { value } : {}),
    at: option.at,
    moved: false,
  };
}

/** A container the view creates on the way to a forward, written nowhere. */
function containerFor(next: Segment, literal: unknown, canonicalKind: (kind: string) => string, union: ConditionedExpansion): object {
  const child: Record<string, unknown> | unknown[] = typeof next === "number" ? [] : {};
  const declared = isPlainObject(literal) ? (literal as { kind?: unknown }).kind : undefined;
  if (typeof declared === "string" && !Array.isArray(child)) child.kind = canonicalKind(declared);
  union.hold(child);
  return child;
}

/** An array gap is filled with an empty object, whose own issues sit at a path
 *  no forward covers — where the body holds an item a lifted choice decides,
 *  only where that item is there. */
function fillGaps(container: unknown, segment: Segment, literalItems: readonly unknown[] | undefined): void {
  if (!Array.isArray(container) || typeof segment !== "number") return;
  for (let j = container.length; j < segment; j++) {
    const item = literalItems?.[j];
    container[j] = isAlternatives(item)
      ? new Alternatives(item.options.map((option) => mirrored(option, option.present, {})))
      : {};
  }
}

function isPlainContainer(value: unknown): boolean {
  return !!value && typeof value === "object" && !isAlternatives(value) && !isOpaque(value);
}

function viewMetadata(root: ResourceManifest, name: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(root.metadata as Record<string, unknown>) };
  // Where the consumer was extracted from, and the slot context it was extracted
  // under, describe the consumer — never a resource of the entry's kind.
  delete metadata.xTeloOrigin;
  delete metadata.xTeloInvocationContext;
  metadata.name = name;
  return metadata;
}

function celSource(value: unknown): string | undefined {
  if (isTaggedSentinel(value)) return value.engine === CEL_ENGINE ? value.source : undefined;
  if (isCompiled(value)) {
    const source = (value as { source?: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

function isCompiled(value: unknown): boolean {
  return !!value && typeof value === "object" && !!(value as { __compiled?: unknown }).__compiled;
}

/** A leaf no forward can sit below: an expression, a reference, an embed. */
function isOpaque(value: unknown): boolean {
  return (
    isTaggedSentinel(value) ||
    isRefSentinel(value) ||
    isCompiled(value)
  );
}

function isPlainObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && !isOpaque(value) && !isAlternatives(value);
}
