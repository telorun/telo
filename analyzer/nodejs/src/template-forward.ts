import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { CEL_ENGINE, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { moduleScopedDefResolver, type AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  celEvalModeAt,
  kindCelEvalSites,
  NO_CEL_EVAL_SITES,
  type CelEvalSites,
} from "./eval-paths.js";
import {
  controllerBearingAncestor,
  hasOwnControllerOrTemplate,
  type DefResolver,
} from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import { cloneForMutation, normalizeInlineResources } from "./normalize-inline-resources.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { templateBodies } from "./template-body.js";
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
 * What a diagnostic about a view means is decided by its path: a path inside a
 * forwarded value is reported at the consumer's own path, in the consumer's file
 * (`routes[0].returns[0].status` → `workflows[0].returns[0].status`); anything
 * else describes the entry's literal content or the view itself, which is the
 * defining module's to check, and is dropped. A forward that also violates a
 * constraint the enclosing kind restates is reported ONCE — the consumer's own
 * diagnostic at that path and code wins.
 *
 * A CEL expression belongs to the one resource that evaluates it. The enclosing
 * kind evaluates a forwarded value only where its own schema marks the path
 * compile-eval (the kernel expands those at `create()`, so the value forwarded is
 * already data); everywhere else the kernel leaves the expression compiled and
 * the entry's controller evaluates it. So the consumer's check at a forwarded
 * path defers to the view, and the view skips what its consumer evaluates.
 *
 * Views are built for the entry's own modules' declarations only, like every
 * other declaration check, and nest: an entry whose kind is itself templated is
 * a consumer in turn. Browser-safe.
 */

type Segment = string | number;

/** One forward inside a template body entry. */
export interface TemplateForward {
  /** Where it sits in the entry (`routes`, `openapi.info.title`, `mounts[0].mount`). */
  readonly at: readonly Segment[];
  /** The `self` path it forwards (`["workflows"]`). */
  readonly self: readonly string[];
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
 *  `metadata`. A forward is a leaf: nothing below one is written. */
export function templateForwardsOf(entry: unknown): TemplateForward[] {
  const out: TemplateForward[] = [];
  const visit = (value: unknown, at: Segment[]): void => {
    const self = at.length > 0 ? selfForwardPath(value) : undefined;
    if (self) {
      out.push({ at, self });
      return;
    }
    if (isOpaque(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...at, i]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (at.length === 0 && (key === "kind" || key === "metadata")) continue;
      visit(child, [...at, key]);
    }
  };
  visit(entry, []);
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

/** True when `path` is `prefix` or lies below it. */
function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** A node the view holds at `at` is what the consumer wrote at `from`. */
interface ForwardLink {
  readonly at: string;
  readonly from: string;
}

interface ForwardedEntry {
  readonly view: ResourceManifest;
  /** The entry's kind as its body writes it, and its name — for messages. */
  readonly entryKind: string;
  readonly entryName: string;
  /** The declaration whose value this view holds — the consumer, or a view one
   *  template further out. */
  readonly upstream: ResourceManifest;
  /** Into `upstream`'s paths. */
  readonly links: readonly ForwardLink[];
  /** Into the ROOT consumer's paths, which is where a diagnostic is reported. */
  readonly root: ResourceManifest;
  readonly rootLinks: readonly ForwardLink[];
}

/** The views an analysis carries, and the two questions asked of them. */
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

  /** Everything to analyze beside the manifests the views were built from. */
  get analyzed(): ResourceManifest[] {
    return [...this.manifests, ...this.extractions];
  }

  /** Where `manifest`'s own kind evaluates CEL — read to decide who owns a
   *  forwarded expression. */
  addHolder(manifest: ResourceManifest, sites: CelEvalSites): void {
    this.sites.set(manifest, sites);
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
   * Report every diagnostic about a view at its consumer, or drop it.
   *
   * `diagnostics` are already rerouted to the declaration each was written in,
   * so one about a view's extraction arrives on the view. A path inside a
   * forwarded value moves to the consumer's own path; any other path is the
   * entry's literal content or the view's own identity, which is the defining
   * module's concern. The consumer may itself be an extraction, so what is moved
   * is rerouted again by `reroute`. A forwarded diagnostic the consumer's own
   * analysis already makes — same code, same path — is dropped, so a constraint
   * the enclosing kind restates is reported once.
   */
  mapDiagnostics(
    diagnostics: AnalysisDiagnostic[],
    reroute: (moved: AnalysisDiagnostic[]) => AnalysisDiagnostic[],
  ): AnalysisDiagnostic[] {
    if (this.byName.size === 0) return diagnostics;
    const own: AnalysisDiagnostic[] = [];
    const moved: AnalysisDiagnostic[] = [];
    for (const d of diagnostics) {
      const entry = this.entryOf(d);
      if (!entry) {
        own.push(d);
        continue;
      }
      const m = this.moveToConsumer(d, entry);
      if (m) moved.push(m);
    }
    const reported = new Set(own.map(identityKey));
    const out = [...own];
    for (const m of reroute(moved)) {
      const key = identityKey(m);
      if (reported.has(key) || reported.has(`${key}\0${m.message}`)) continue;
      reported.add(`${key}\0${m.message}`);
      out.push(m);
    }
    return out;
  }

  private entryOf(d: AnalysisDiagnostic): ForwardedEntry | undefined {
    const name = (d.data as { resource?: { name?: unknown } } | undefined)?.resource?.name;
    return typeof name === "string" ? this.byName.get(name) : undefined;
  }

  private moveToConsumer(
    d: AnalysisDiagnostic,
    entry: ForwardedEntry,
  ): AnalysisDiagnostic | undefined {
    const data = d.data as { path?: unknown; filePath?: string };
    const path = typeof data.path === "string" ? data.path : "";
    const link = entry.rootLinks.find((l) => covers(l.at, path));
    if (!link) return undefined;
    const viewLabel = `${entry.view.kind}/${entry.view.metadata!.name as string}`;
    const entryLabel = `the ${entry.entryKind} entry '${entry.entryName}'`;
    const inner = (d.message.startsWith(`${viewLabel}: `)
      ? d.message.slice(viewLabel.length + 2)
      : d.message
    ).split(viewLabel).join(entryLabel);
    const root = entry.root;
    const rootName = root.metadata?.name as string;
    return {
      ...d,
      message:
        `${root.kind}/${rootName}: '${link.from}' is forwarded into ${entryLabel} as ` +
        `'${link.at}', which checks it as its own field — ${inner}`,
      data: {
        ...data,
        resource: { kind: root.kind, name: rootName },
        filePath: (root.metadata as { source?: string } | undefined)?.source ?? data.filePath,
        path: link.from + path.slice(link.at.length),
      },
    } as AnalysisDiagnostic;
  }
}

function identityKey(d: AnalysisDiagnostic): string {
  const data = d.data as
    | { resource?: { kind?: string; name?: string }; path?: unknown; filePath?: string }
    | undefined;
  return [
    d.code,
    data?.resource?.kind ?? "",
    data?.resource?.name ?? "",
    data?.filePath ?? "",
    typeof data?.path === "string" ? data.path : "",
  ].join("\0");
}

/** A declaration a view is built for, and where its value came from. */
interface Holder {
  readonly manifest: ResourceManifest;
  readonly definition: ResourceDefinition;
  readonly root: ResourceManifest;
  /** Undefined for the root consumer itself. */
  readonly rootLinks: readonly ForwardLink[] | undefined;
  /** The templated definitions already expanded above this one — a body whose
   *  entry is a kind on this chain would expand forever. */
  readonly chain: ReadonlySet<ResourceDefinition>;
}

/**
 * The views of every forward made by a declaration of the entry's own modules,
 * nested templates included. Read from manifests whose references are already
 * resolved (after Phase 2.5), so a view holds exactly what the kernel forwards.
 */
export function buildTemplateForwardViews(
  manifests: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: ReadonlySet<string> },
): TemplateForwardViews {
  const views = new TemplateForwardViews();
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);
  const taken = new Set<string>();
  for (const m of manifests) {
    if (typeof m.metadata?.name === "string") taken.add(m.metadata.name);
  }

  const queue: Holder[] = [];
  for (const m of manifests) {
    if (!isConsumer(m, scopes.rootModules)) continue;
    const definition = definitionInScope<ResourceDefinition>(
      registry,
      m.kind,
      m.metadata,
      aliases,
      scopes.aliasesByModule,
    );
    if (!definition || definition.kind !== "Telo.Definition") continue;
    queue.push({ manifest: m, definition, root: m, rootLinks: undefined, chain: new Set([definition]) });
  }

  for (let i = 0; i < queue.length; i++) {
    const holder = queue[i]!;
    const entries = forwardedEntries(holder, registry, aliases, scopes, resolveDef);
    if (entries.length === 0) continue;
    views.addHolder(holder.manifest, kindCelEvalSites(holder.definition, resolveDef));
    for (const entry of entries) {
      const rootLinks = holder.rootLinks ? composeLinks(entry.links, holder.rootLinks) : entry.links;
      if (rootLinks.length === 0) continue;
      let name = `${holder.manifest.metadata!.name as string}→${entry.name}`;
      for (let n = 2; taken.has(name); n++) name = `${holder.manifest.metadata!.name as string}→${entry.name}#${n}`;
      taken.add(name);
      // An inline declaration the consumer's kind declares no slot for reaches
      // the view unextracted; the entry's slot extracts it, as a resource of
      // its own kind, exactly as it would for a top-level declaration.
      const [view, ...extracted] = normalizeInlineResources(
        [{ ...entry.body, metadata: viewMetadata(holder.root, name) } as unknown as ResourceManifest],
        registry,
        aliases,
        scopes.aliasesByModule,
      );
      views.extractions.push(...extracted);
      views.addEntry({
        view: view!,
        entryKind: entry.writtenKind,
        entryName: entry.name,
        upstream: holder.manifest,
        links: entry.links,
        root: holder.root,
        rootLinks,
      });
      views.addHolder(view!, kindCelEvalSites(entry.definition, resolveDef));
      if (!holder.chain.has(entry.definition)) {
        queue.push({
          manifest: view!,
          definition: entry.definition,
          root: holder.root,
          rootLinks,
          chain: new Set([...holder.chain, entry.definition]),
        });
      }
    }
  }
  return views;
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
}

function forwardedEntries(
  holder: Holder,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: ReadonlySet<string> },
  resolveDef: DefResolver,
): BuiltEntry[] {
  const definition = holder.definition;
  // An `extends` child with no body of its own runs its ancestor's, handed its
  // own config — or, with `base:`, the mapping evaluated over it.
  const runner = hasOwnControllerOrTemplate(definition)
    ? definition
    : controllerBearingAncestor(definition, resolveDef);
  if (!runner) return [];
  const base = runner === definition ? undefined : (definition as { base?: unknown }).base;
  const runnerScope = moduleAliasScope(runner.metadata, aliases, scopes.aliasesByModule);
  const canonicalInRunner = (kind: string): string => runnerScope?.resolveKind(kind) ?? kind;

  const out: BuiltEntry[] = [];
  for (const body of templateBodies(runner as unknown as ResourceManifest, registry, aliases, scopes)) {
    const entryDefinition = body.definition;
    if (!entryDefinition) continue;
    const kind = canonicalKindOf(entryDefinition);
    if (registry.resolve(kind) !== entryDefinition) continue;
    const view: Record<string, unknown> = { kind };
    const links: ForwardLink[] = [];
    for (const forward of templateForwardsOf(body.manifest)) {
      const source =
        base == null
          ? fromSelf(holder.manifest, forward.self)
          : throughBase(base, forward.self, holder.manifest);
      if (!source) continue;
      place(view, body.manifest, forward.at, source.value, canonicalInRunner);
      for (const link of source.links) {
        links.push({ at: formatPath([...forward.at, ...link.at]), from: formatPath(link.from) });
      }
    }
    if (links.length === 0) continue;
    const entryName = body.manifest.metadata?.name;
    out.push({
      body: view,
      definition: entryDefinition,
      writtenKind: body.manifest.kind,
      name: typeof entryName === "string" ? entryName : body.prefix,
      links,
    });
  }
  return out;
}

function canonicalKindOf(definition: ResourceDefinition): string {
  const { name, module } = definition.metadata;
  return module ? `${module}.${name}` : name;
}

/** A value the view holds, and which of its nodes came from where. */
interface Sourced {
  readonly value: unknown;
  readonly links: readonly { at: Segment[]; from: string[] }[];
}

/** `self` is the declaration's own configuration. */
function fromSelf(manifest: ResourceManifest, self: readonly string[]): Sourced | undefined {
  const value = navigate(manifest, self);
  if (value === undefined) return undefined;
  return { value: cloneForMutation(value), links: [{ at: [], from: [...self] }] };
}

/**
 * `self` is the `base:` mapping evaluated over the declaration. What the mapping
 * forwards verbatim is the consumer's; what it computes is data the consumer did
 * not write at any one place, and its literal content is the defining module's —
 * neither has a consumer path to be reported at, so both stay out of the view.
 */
function throughBase(
  base: unknown,
  self: readonly string[],
  manifest: ResourceManifest,
): Sourced | undefined {
  let node: unknown = base;
  for (let i = 0; i < self.length; i++) {
    const forwarded = selfForwardPath(node);
    if (forwarded) return fromSelf(manifest, [...forwarded, ...self.slice(i)]);
    if (!isPlainObject(node)) return undefined;
    node = (node as Record<string, unknown>)[self[i]!];
    if (node === undefined) return undefined;
  }
  const forwarded = selfForwardPath(node);
  if (forwarded) return fromSelf(manifest, forwarded);
  const links: { at: Segment[]; from: string[] }[] = [];
  const materialize = (value: unknown, at: Segment[]): unknown => {
    const path = selfForwardPath(value);
    if (path) {
      const consumer = navigate(manifest, path);
      if (consumer === undefined) return undefined;
      links.push({ at, from: path });
      return cloneForMutation(consumer);
    }
    if (isOpaque(value)) return undefined;
    if (Array.isArray(value)) return value.map((item, i) => materialize(item, [...at, i]) ?? {});
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const materialized = materialize(child, [...at, key]);
        if (materialized !== undefined) out[key] = materialized;
      }
      return out;
    }
    return value;
  };
  const value = materialize(node, []);
  return links.length > 0 ? { value, links } : undefined;
}

/** Links of a view built from a view, re-expressed against the root consumer. A
 *  forward may take a node the outer view holds, or a subtree containing one. */
function composeLinks(
  links: readonly ForwardLink[],
  outer: readonly ForwardLink[],
): ForwardLink[] {
  const out: ForwardLink[] = [];
  for (const link of links) {
    for (const o of outer) {
      if (covers(o.at, link.from)) {
        out.push({ at: link.at, from: o.from + link.from.slice(o.at.length) });
      } else if (covers(link.from, o.at)) {
        out.push({ at: link.at + o.at.slice(link.from.length), from: o.from });
      }
    }
  }
  return out;
}

/**
 * Set `value` at `at` in the view, creating what lies above it. A container on
 * the way that the entry writes as an inline declaration keeps its kind, in
 * canonical form, so the value below it is still checked against that kind.
 */
function place(
  view: Record<string, unknown>,
  entry: unknown,
  at: readonly Segment[],
  value: unknown,
  canonicalKind: (kind: string) => string,
): void {
  let container: unknown = view;
  let literal: unknown = entry;
  for (let i = 0; i < at.length - 1; i++) {
    const segment = at[i]!;
    literal =
      literal && typeof literal === "object"
        ? (literal as Record<string | number, unknown>)[segment]
        : undefined;
    let child = (container as Record<string | number, unknown>)[segment];
    if (!child || typeof child !== "object") {
      child = typeof at[i + 1] === "number" ? [] : {};
      const declared = isPlainObject(literal) ? (literal as { kind?: unknown }).kind : undefined;
      if (typeof declared === "string" && !Array.isArray(child)) {
        (child as Record<string, unknown>).kind = canonicalKind(declared);
      }
      setAt(container, segment, child);
    }
    container = child;
  }
  setAt(container, at[at.length - 1]!, value);
}

/** An array gap is filled with an empty object, whose own issues sit at a path
 *  no forward covers. */
function setAt(container: unknown, segment: Segment, value: unknown): void {
  if (Array.isArray(container) && typeof segment === "number") {
    for (let j = container.length; j < segment; j++) container[j] = {};
  }
  (container as Record<string | number, unknown>)[segment] = value;
}

function navigate(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (!isPlainObject(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
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
  if (typeof value === "string") return /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value)?.[1];
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
    isCompiled(value) ||
    (typeof value === "string" && value.includes("${{"))
  );
}

function isPlainObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && !isOpaque(value);
}
