/**
 * The outline — what an application does, read from its manifest.
 *
 * A projection of the module graph, joined with what the graph does not carry:
 * the application contract, the need table's environment, the per-field CEL
 * read chains, the throws unions and the catch ladder. It walks no step array
 * and no `x-telo-ref` of its own — rows, edges and their order are the graph's,
 * so an outline item's id IS the module-graph id for the same manifest path. A
 * resource reached from several places is one item.
 *
 * Nothing is evaluated and nothing is omitted: every value is shown as written,
 * in the written-value encoding (`written-value.ts`) — an expression by its tag
 * and source with its static type where the analyzer has one, a literal mapping
 * as `{ map }`; a secret appears by name and binding only; a resource is shown
 * by its kind, contract, throws and deprecation, never by its configuration.
 *
 * The JSON form is versioned `outlineVersion: 1`; later versions only extend it.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { celExpressionsOf, walkCelExpressions } from "@telorun/templating";
import { argumentSynopsisOf } from "./application-arguments.js";
import { readApplicationContract, type ContractRequirements } from "./application-contract.js";
import type { Assignment } from "./configuration-dimensions.js";
import { accessChains } from "./cel-access-chains.js";
import { nodeIdFor, type CallGraph } from "./call-graph.js";
import type { CatchLadder, CatchListAnswer, ScopeRung, SiteLadder } from "./catch-scope.js";
import { readDeprecation, type Deprecation } from "./deprecation.js";
import type { ContractDirection } from "./extends-resolution.js";
import { readGraphMatch, type GraphEdge, type GraphNode, type GraphRow, type ModuleGraph } from "./module-graph.js";
import { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
import type { NeedEnvironmentEntry, NeedImporterEntry, NeedTable } from "./need-table.js";
import { isTriggerUse } from "./ref-slot.js";
import { resolveThrowsUnion, type ThrowsUnion } from "./resolve-throws-union.js";
import { readResourceInputs } from "./resource-input.js";
import { collectRunReachableNames } from "./validate-observed-state.js";
import { writtenValueOf, type WrittenValue, type WrittenValueContext } from "./written-value.js";

export const OUTLINE_VERSION = 1;

export interface OutlineDocument {
  outlineVersion: typeof OUTLINE_VERSION;
  module: OutlineModule;
  inputs: OutlineInput[];
  /** An Application's `targets:`, in order. Empty for a Library. */
  boot: OutlineBootTarget[];
  /** Ids of the resources the walk starts from, in order: an Application's
   *  boot targets plus every service a control edge starts; a Library's
   *  exported instances. */
  roots: string[];
  entryPoints: OutlineEntryPoint[];
  resources: OutlineResource[];
  unreached: OutlineUnreached[];
}

export interface OutlineModule {
  name: string;
  kind: string;
  version?: string;
  description?: string;
}

export interface OutlineInput {
  block: "variables" | "secrets" | "ports" | "needs" | "resources";
  /** The entry's name; a need's need path joined by `.`. */
  name: string;
  /** How a root Application's variable, secret or port is supplied: its `env:`
   *  name and its command-line argument in the synopsis notation `--help`
   *  prints. */
  binding?: { env?: string; arg?: string };
  /** A need's fields, each with the environment name it is read from — none
   *  for a Library, which reads nothing from the environment. */
  fields?: Record<string, OutlineNeedField>;
  /** The value type (`string`, `Telo.HostPath`, `Telo.TcpPort`), the need
   *  type, or the kind a resource input is constrained to. */
  type?: string;
  /** For an Application, true when some configuration requires the input; for
   *  a Library, when its importer must supply it. */
  required: boolean;
  /** An Application input's configurations requiring it, as partial
   *  assignments keyed by dimension; present only when it is required and not in
   *  every configuration. */
  requiredWhen?: Assignment[];
  /** The declared default — never a secret's. */
  default?: WrittenValue;
  /** The resource fields whose expressions read the input. */
  readBy: OutlineRead[];
}

export interface OutlineNeedField {
  env?: string;
  envSource?: "bound" | "derived";
  required: boolean;
  sensitive: boolean;
}

export interface OutlineRead {
  /** Id of the resource (or the module root) whose field reads it. */
  resource: string;
  path: string;
}

export interface OutlineBootTarget {
  /** The module-graph row id of the target. */
  id: string;
  index: number;
  name?: string;
  /** Id of the resource it starts, when the name resolves. */
  target?: string;
  targetName?: string;
  when?: WrittenValue;
}

export interface OutlineEntryPoint {
  /** The module-graph edge id of the trigger. */
  id: string;
  /** Id of the resource that registers the handler. */
  owner: string;
  /** Row the trigger sits in, inside an entry list. */
  row?: string;
  slot: string;
  path: string;
  use: string[];
  /** What selects this entry point: its row's matcher values inside an entry
   *  list, its kind's top-level matchers outside one. */
  match?: Record<string, WrittenValue>;
  handler?: string;
  handlerName: string;
  throws: { codes: string[]; unbounded: boolean };
  /** Per code — and once for any other code of an unbounded union — the
   *  `catches:` entry that renders it on each rung of the ladder. */
  catches: OutlineCatchAnswer[];
}

export interface OutlineCatchAnswer {
  /** `null` for any code the union cannot enumerate. */
  code: string | null;
  /** Every path the throw can take renders it. */
  covered: boolean;
  /** The site's own list, when it holds an entry. */
  own?: OutlineListAnswer;
  scope: OutlineScopeRung;
}

export interface OutlineListAnswer {
  /** Path of the list in its resource. */
  list: string;
  /** The first entry proven to render the code. */
  entry?: number;
  /** Entries before it whose `when:` decides at run time. */
  undecided: number[];
}

export interface OutlineScopeRung {
  resource: string;
  covered: boolean;
  /** The resource's scope list, when it holds an entry. */
  list?: OutlineListAnswer;
  enclosers: OutlineScopeRung[];
}

export interface OutlineResource {
  id: string;
  name: string;
  /** As written. */
  kind: string;
  /** What `kind` resolves to, when it differs. */
  canonicalKind?: string;
  module?: string;
  /** Declared in another module: a leaf naming its module. */
  external?: boolean;
  alias?: string;
  /** A library's input stand-in — a resource or need its importer supplies. */
  injected?: boolean;
  /** The resource whose declaration encloses this one (`with:`, inline). */
  owner?: string;
  capability?: string;
  contract?: { inputType?: Record<string, unknown>; outputType?: Record<string, unknown> };
  throws?: { codes: string[]; unbounded: boolean };
  deprecated?: Deprecation;
  /** The execution zones it provides: the slot, and what each guarantees. */
  zones?: { site: string; attributes: Record<string, string> }[];
  /** Its body in written order — steps, entries, declarations written at a
   *  dispatch site — each with the edges leaving it. */
  rows: OutlineRow[];
  /** The edges leaving the resource itself rather than one of its rows. */
  edges: OutlineEdge[];
}

export interface OutlineRow {
  id: string;
  kind: "step" | "entry" | "inline" | "reference";
  path: string;
  name?: string;
  parent?: string;
  /** The branch of the parent this row sits in (`then`, `else`, `catch`). */
  branch?: string;
  /** What the step is, as the grammar's branch keys (`if+then`, `invoke`). */
  variant?: string;
  /** The field holding the predicate (`if`, `while`, `switch`, `when`). */
  predicateField?: string;
  /** What decides whether or how the step runs, as written. */
  predicate?: WrittenValue;
  match?: Record<string, WrittenValue>;
  /** The kind a declaration written at a dispatch site names. */
  declares?: string;
  edges: OutlineEdge[];
}

export interface OutlineEdge {
  id: string;
  use: string[];
  class: string;
  slot: string;
  path: string;
  target?: string;
  targetName: string;
  /** The call's argument map, as written. */
  inputs?: WrittenValue;
  match?: Record<string, WrittenValue>;
  /** A CEL read of another resource's published state, as written. */
  read?: string;
  /** A module function call, as written. */
  call?: string;
}

export interface OutlineUnreached {
  id: string;
  name: string;
  kind: string;
}

/** What the outline reads, each piece owned elsewhere. */
export interface OutlineSources {
  manifests: ResourceManifest[];
  /** The module doc the outline describes. */
  root: ResourceManifest | undefined;
  graph: ModuleGraph;
  callGraph: CallGraph;
  /** A kind resolved in its declaring module's scope. */
  definition(kind: string, module?: string): ResourceDefinition | undefined;
  ladder: CatchLadder;
  /** The analysis's need table: the inputs' needs are read from it alone. */
  needs: NeedTable | undefined;
  /** An Application's requirements: which configurations require each input
   *  and need. Undefined for a Library. */
  requirements: ContractRequirements | undefined;
  contract(manifest: ResourceManifest, direction: ContractDirection): Record<string, unknown> | undefined;
  /** The static type of an expression at `path` of `manifest`, when known. */
  expressionType(manifest: ResourceManifest, path: string, engine: string, source: string): string | undefined;
  /** The concrete paths of a resource's filled reference sites. */
  referenceSites(manifest: ResourceManifest): ReadonlySet<string>;
}

/** A value of `manifest` written at `path`, encoded. */
type ValueOf = (manifest: ResourceManifest, path: string, value: unknown) => WrittenValue | undefined;

/** The typed `match` of an entry `row`, or of a trigger edge outside every
 *  entry list when there is no row. */
type MatchOf = (
  node: GraphNode,
  manifest: ResourceManifest,
  row: GraphRow | undefined,
) => Record<string, WrittenValue> | undefined;

const BODY_ROWS: ReadonlySet<string> = new Set(["step", "entry", "inline", "reference"]);

export function buildOutline(sources: OutlineSources): OutlineDocument {
  const { graph, root } = sources;
  const manifestOf = manifestIndex(sources);
  const nodeIdOf = new Map<ResourceManifest, string>();
  for (const [id, manifest] of manifestOf) nodeIdOf.set(manifest, id);
  const rootId = graph.root?.id;
  const application = root?.kind === "Telo.Application";

  const roots = rootsOf(sources, application);
  const reached = reachFrom(graph, roots);

  const contexts = new Map<ResourceManifest, WrittenValueContext>();
  const contextOf = (manifest: ResourceManifest): WrittenValueContext => {
    let context = contexts.get(manifest);
    if (!context) {
      let sites: ReadonlySet<string> | undefined;
      context = {
        isReferenceSite: (at) => (sites ??= sources.referenceSites(manifest)).has(at),
        typeOf: (at, engine, source) => sources.expressionType(manifest, at, engine, source),
      };
      contexts.set(manifest, context);
    }
    return context;
  };
  const valueOf: ValueOf = (manifest, path, value) => writtenValueOf(value, path, contextOf(manifest));
  // The graph's `match` is untyped — a row's id derives from it — so each is
  // read again by the same matcher reader, typed.
  const matchOf: MatchOf = (node, manifest, row) =>
    readGraphMatch(
      manifest,
      sources.definition(node.kind, node.module)?.schema as Record<string, any> | undefined,
      row,
      contextOf(manifest),
    );

  const resources: OutlineResource[] = [];
  const entryPoints: OutlineEntryPoint[] = [];
  for (const id of reached) {
    const node = graph.nodeById(id);
    const manifest = manifestOf.get(id);
    if (!node || node.root) continue;
    resources.push(outlineResource(node, manifest, sources, valueOf, matchOf));
    if (!manifest || node.external || node.ownership === "injected") continue;
    for (const edge of graph.edgesFrom(id)) {
      if (!edge.use.some(isTriggerUse)) continue;
      entryPoints.push(entryPointOf(node, manifest, edge, sources, manifestOf, nodeIdOf, matchOf));
    }
  }

  const unreached: OutlineUnreached[] = [];
  const touched = new Set(reached);
  for (const id of reached) for (const edge of graph.edgesFrom(id)) if (edge.to) touched.add(edge.to);
  for (const node of graph.nodes) {
    if (node.root || node.external || touched.has(node.id)) continue;
    if (node.ownership === "injected" || node.ownership === "forwarded" || node.ownership === "enclosing") continue;
    unreached.push({ id: node.id, name: node.name, kind: node.kind });
  }

  const metadata = (root?.metadata ?? {}) as Record<string, unknown>;
  return {
    outlineVersion: OUTLINE_VERSION,
    module: {
      name: typeof metadata.name === "string" ? metadata.name : "",
      kind: root?.kind ?? "",
      ...(typeof metadata.version === "string" ? { version: metadata.version } : {}),
      ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
    },
    inputs: inputsOf(sources, application, manifestOf, rootId),
    boot: application ? bootOf(sources, valueOf) : [],
    roots,
    entryPoints,
    resources,
    unreached,
  };
}

/** The manifest each graph node was minted from — a declaration of the set, a
 *  `with:`-scoped one the call graph found, and the module root. */
function manifestIndex(sources: OutlineSources): Map<string, ResourceManifest> {
  const out = new Map<string, ResourceManifest>();
  const ids = new Set(sources.graph.nodes.map((n) => n.id));
  for (const node of sources.callGraph.nodes.values()) {
    if (node.type === "resource" && ids.has(node.id)) out.set(node.id, node.manifest);
  }
  for (const manifest of sources.manifests) {
    if (typeof manifest.metadata?.name !== "string" || !manifest.kind) continue;
    const id = nodeIdFor(manifest);
    if (ids.has(id) && !out.has(id)) out.set(id, manifest);
  }
  if (sources.graph.root && sources.root) out.set(sources.graph.root.id, sources.root);
  return out;
}

/** Where the walk starts: an Application's boot targets in order, then every
 *  service a control edge starts; a Library's exported instances. */
function rootsOf(sources: OutlineSources, application: boolean): string[] {
  const { graph } = sources;
  const rootId = graph.root?.id;
  if (!rootId) return [];
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  const fromRoot = graph.edgesFrom(rootId);
  if (!application) {
    for (const edge of fromRoot) if (edge.slot === "exports.resources") add(edge.to);
    return out;
  }
  const rowIndex = new Map(graph.root!.rows.map((row) => [row.id, row.index] as const));
  const boot = fromRoot
    .filter((edge) => edge.boot)
    .sort((a, b) => (rowIndex.get(a.row ?? "") ?? 0) - (rowIndex.get(b.row ?? "") ?? 0));
  for (const edge of boot) add(edge.to);
  const started = collectRunReachableNames(sources.callGraph);
  for (const node of graph.nodes) {
    if (node.root || node.external || node.capability !== "Telo.Service") continue;
    if (started.has(node.name)) add(node.id);
  }
  return out;
}

/** Every resource reachable from the roots by every edge but a `schema` one,
 *  depth first in edge order — an imported instance is a leaf the walk does not
 *  enter, and a declaration enclosed by a reached resource is reached with it. */
function reachFrom(graph: ModuleGraph, roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const enclosed = new Map<string, string[]>();
  for (const region of graph.regions) {
    if (region.kind === "zone") continue;
    const members = enclosed.get(region.owner);
    if (members) members.push(...region.members);
    else enclosed.set(region.owner, [...region.members]);
  }
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const node = graph.nodeById(id);
    if (!node) return;
    seen.add(id);
    out.push(id);
    if (node.external) return;
    for (const edge of graph.edgesFrom(id)) {
      if (edge.class !== "shape" && edge.to) visit(edge.to);
    }
    for (const member of enclosed.get(id) ?? []) visit(member);
  };
  for (const id of roots) visit(id);
  return out;
}

function outlineResource(
  node: GraphNode,
  manifest: ResourceManifest | undefined,
  sources: OutlineSources,
  valueOf: ValueOf,
  matchOf: MatchOf,
): OutlineResource {
  const { graph } = sources;
  const definition = sources.definition(node.kind, node.module);
  const out: OutlineResource = {
    id: node.id,
    name: node.name,
    kind: node.kind,
    ...(node.canonicalKind ? { canonicalKind: node.canonicalKind } : {}),
    ...(node.module ? { module: node.module } : {}),
    ...(node.external ? { external: true } : {}),
    ...(node.alias ? { alias: node.alias } : {}),
    ...(node.ownership === "injected" ? { injected: true } : {}),
    ...(node.owner ? { owner: node.owner } : {}),
    ...(node.capability ? { capability: node.capability } : {}),
    rows: [],
    edges: [],
  };
  if (manifest) {
    const inputType = sources.contract(manifest, "inputType");
    const outputType = sources.contract(manifest, "outputType");
    if (inputType || outputType) {
      out.contract = { ...(inputType ? { inputType } : {}), ...(outputType ? { outputType } : {}) };
    }
    const throws = summarize(resolveThrowsUnion(manifest, sources.ladder.resolveCtx));
    if (throws.codes.length > 0 || throws.unbounded) out.throws = throws;
  }
  const deprecated = readDeprecation(definition?.metadata);
  if (deprecated) out.deprecated = deprecated;
  const zones = graph.regions
    .filter((r) => r.kind === "zone" && r.owner === node.id)
    .map((r) => ({ site: r.site, attributes: { ...(r.attributes ?? {}) } }));
  if (zones.length > 0) out.zones = zones;
  if (!manifest || node.external || node.ownership === "injected") return out;

  const edges = graph.edgesFrom(node.id);
  const rowById = new Map(node.rows.map((row) => [row.id, row] as const));
  for (const row of node.rows) {
    if (!BODY_ROWS.has(row.kind)) continue;
    const parent = row.parent ? rowById.get(row.parent) : undefined;
    const branch = parent && row.array.startsWith(`${parent.path}.`) ? row.array.slice(parent.path.length + 1) : undefined;
    const predicate = row.kind === "step" ? predicateOf(row, manifest, valueOf) : undefined;
    const match = row.match ? matchOf(node, manifest, row) : undefined;
    out.rows.push({
      id: row.id,
      kind: row.kind as OutlineRow["kind"],
      path: row.path,
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.parent !== undefined ? { parent: row.parent } : {}),
      ...(branch ? { branch } : {}),
      ...(row.variant !== undefined ? { variant: row.variant } : {}),
      ...(predicate !== undefined ? { predicateField: row.predicateField, predicate } : {}),
      ...(match ? { match } : {}),
      ...(row.declares !== undefined ? { declares: row.declares } : {}),
      edges: edges
        .filter((e) => e.row === row.id)
        .map((e) => outlineEdge(e, row, manifest, valueOf, e.match ? matchOf(node, manifest, undefined) : undefined)),
    });
  }
  out.edges = edges
    .filter((e) => !e.row || !rowById.has(e.row))
    .map((e) => outlineEdge(e, undefined, manifest, valueOf, e.match ? matchOf(node, manifest, undefined) : undefined));
  return out;
}

/** A row's predicate as written: the expression at the field the module graph
 *  names for it. */
function predicateOf(row: GraphRow, manifest: ResourceManifest, valueOf: ValueOf): WrittenValue | undefined {
  if (row.predicateField === undefined) return undefined;
  const path = `${row.path}.${row.predicateField}`;
  return valueOf(manifest, path, valueAt(manifest, path));
}

function outlineEdge(
  edge: GraphEdge,
  row: GraphRow | undefined,
  manifest: ResourceManifest,
  valueOf: ValueOf,
  match: Record<string, WrittenValue> | undefined,
): OutlineEdge {
  const inputsPath =
    row?.inputs ?? (edge.inputs !== undefined && !row ? edge.inputs.replace(/^\//, "").replace(/\//g, ".") : undefined);
  const inputs = inputsPath !== undefined ? valueOf(manifest, inputsPath, valueAt(manifest, inputsPath)) : undefined;
  return {
    id: edge.id,
    use: [...edge.use],
    class: edge.class,
    slot: edge.slot,
    path: edge.path,
    ...(edge.to ? { target: edge.to } : {}),
    targetName: edge.toName,
    ...(inputs !== undefined ? { inputs } : {}),
    ...(match ? { match } : {}),
    ...(edge.read !== undefined ? { read: edge.read } : {}),
    ...(edge.call !== undefined ? { call: edge.call } : {}),
  };
}

function entryPointOf(
  node: GraphNode,
  manifest: ResourceManifest,
  edge: GraphEdge,
  sources: OutlineSources,
  manifestOf: ReadonlyMap<string, ResourceManifest>,
  nodeIdOf: ReadonlyMap<ResourceManifest, string>,
  matchOf: MatchOf,
): OutlineEntryPoint {
  const { ladder } = sources;
  const row = edge.row ? node.rows.find((r) => r.id === edge.row) : undefined;
  const match = edge.match
    ? matchOf(node, manifest, undefined)
    : row?.kind === "entry" && row.match
      ? matchOf(node, manifest, row)
      : undefined;
  const site = ladder.siteAt(manifest, edge.path);
  const target = edge.to ? manifestOf.get(edge.to) : undefined;
  const union: ThrowsUnion = site
    ? ladder.unionOf(site)
    : target
      ? resolveThrowsUnion(target, ladder.resolveCtx)
      : { codes: new Map(), unbounded: false };
  const throws = summarize(union);
  const idOf = (m: ResourceManifest) => nodeIdOf.get(m) ?? nodeIdFor(m);
  const answer = (ladderAnswer: SiteLadder): OutlineCatchAnswer => ({
    code: ladderAnswer.code,
    covered: ladderAnswer.covered,
    ...(site && site.entries.length > 0 && ladderAnswer.own
      ? { own: listAnswer(site.ownPath, ladderAnswer.own) }
      : {}),
    scope: scopeRungOf(ladderAnswer.scope, idOf),
  });
  const catches = throws.codes.map((code) => answer(ladder.ladderFor(manifest, site, code)));
  if (throws.unbounded) catches.push(answer(ladder.ladderFor(manifest, site, null)));
  return {
    id: edge.id,
    owner: node.id,
    ...(edge.row ? { row: edge.row } : {}),
    slot: edge.slot,
    path: edge.path,
    use: [...edge.use],
    ...(match ? { match } : {}),
    ...(edge.to ? { handler: edge.to } : {}),
    handlerName: edge.toName,
    throws,
    catches,
  };
}

function listAnswer(list: string, answer: CatchListAnswer): OutlineListAnswer {
  return {
    list,
    ...(answer.entry !== undefined ? { entry: answer.entry } : {}),
    undecided: [...answer.undecided],
  };
}

function scopeRungOf(rung: ScopeRung, idOf: (m: ResourceManifest) => string): OutlineScopeRung {
  return {
    resource: idOf(rung.resource),
    covered: rung.covered,
    ...(rung.list && rung.list.entries.length > 0 && rung.answer
      ? { list: listAnswer(rung.list.ownPath, rung.answer) }
      : {}),
    enclosers: rung.enclosers.map((e) => scopeRungOf(e, idOf)),
  };
}

function summarize(union: ThrowsUnion): { codes: string[]; unbounded: boolean } {
  return { codes: [...union.codes.keys()].sort(), unbounded: union.unbounded };
}

function bootOf(sources: OutlineSources, valueOf: ValueOf): OutlineBootTarget[] {
  const { graph, root } = sources;
  if (!graph.root || !root) return [];
  const rootEdges = graph.edgesFrom(graph.root.id);
  return graph.root.rows
    .filter((row) => row.kind === "target")
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const when = predicateOf(row, root, valueOf);
      // What the target starts is its boot edge's to say.
      const edge = rootEdges.find((e) => e.boot && e.row === row.id);
      return {
        id: row.id,
        index: row.index,
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(edge?.to !== undefined ? { target: edge.to } : {}),
        ...(edge ? { targetName: edge.toName } : {}),
        ...(when !== undefined ? { when } : {}),
      };
    });
}

/** Every input the module doc declares, each with the fields reading it. */
function inputsOf(
  sources: OutlineSources,
  application: boolean,
  manifestOf: ReadonlyMap<string, ResourceManifest>,
  rootId: string | undefined,
): OutlineInput[] {
  const { root } = sources;
  if (!root) return [];
  const reads = readsOf(sources, manifestOf, rootId);
  const readBy = (key: string) => reads.get(key) ?? [];
  const out: OutlineInput[] = [];

  if (application) {
    const requirements = sources.requirements;
    if (!requirements) throw new Error("An Application's outline was built without its requirements.");
    const contract = readApplicationContract(root, requirements);
    const requiredWhen = (input: { requiredWhen?: Assignment[] }) =>
      input.requiredWhen ? { requiredWhen: input.requiredWhen } : {};
    for (const v of contract?.variables ?? []) {
      out.push({
        block: "variables",
        name: v.name,
        ...bindingOf(root, "variables", v.name, v.env),
        ...typeOf(v.schema),
        required: v.required,
        ...requiredWhen(v),
        ...("default" in v ? { default: writtenValueOf(v.default, "") } : {}),
        readBy: readBy(`variables\0${v.name}`),
      });
    }
    for (const s of contract?.secrets ?? []) {
      out.push({
        block: "secrets",
        name: s.name,
        ...(s.env ? { binding: { env: s.env } } : {}),
        ...typeOf(s.schema),
        required: s.required,
        ...requiredWhen(s),
        readBy: readBy(`secrets\0${s.name}`),
      });
    }
    for (const p of contract?.ports ?? []) {
      out.push({
        block: "ports",
        name: p.name,
        ...bindingOf(root, "ports", p.name, p.env),
        type: p.protocol === "udp" ? "Telo.UdpPort" : "Telo.TcpPort",
        required: p.required,
        ...requiredWhen(p),
        ...("default" in p ? { default: writtenValueOf(p.default, "") } : {}),
        readBy: readBy(`ports\0${p.name}`),
      });
    }
    for (const entry of sources.needs?.environment ?? []) {
      const input = needInput(entry, readBy);
      const requirement = requirements.inputs.find((i) => i.block === "needs" && i.name === input.name);
      out.push({
        ...input,
        required: requirement?.required ?? input.required,
        ...(requirement?.requiredWhen ? { requiredWhen: [...requirement.requiredWhen] } : {}),
      });
    }
    return out;
  }

  for (const block of ["variables", "secrets"] as const) {
    const entries = (root as Record<string, unknown>)[block];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
      const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const required = entry.default === undefined;
      out.push({
        block,
        name,
        ...typeOf(entry),
        required,
        ...(block === "variables" && !required ? { default: writtenValueOf(entry.default, "") } : {}),
        readBy: readBy(`${block}\0${name}`),
      });
    }
  }
  for (const input of readResourceInputs(root)) {
    out.push({
      block: "resources",
      name: input.name,
      type: input.kind,
      required: true,
      readBy: readBy(`resources\0${input.name}`),
    });
  }
  for (const entry of sources.needs?.entries ?? []) {
    if (entry.supply === "importer") out.push(needInput(entry, readBy));
  }
  return out;
}

/** A need reaching the root unsupplied, the root's own included — with the
 *  environment name each field is read from at an Application's root, and none
 *  at a Library's, whose importer supplies it. */
function needInput(
  entry: NeedEnvironmentEntry | NeedImporterEntry,
  readBy: (key: string) => OutlineRead[],
): OutlineInput {
  const fields: Record<string, OutlineNeedField> = {};
  if (entry.supply === "environment") {
    for (const [field, info] of Object.entries(entry.fields)) {
      fields[field] = { env: info.env, envSource: info.envSource, required: info.required, sensitive: info.sensitive };
    }
  } else {
    for (const [field, info] of Object.entries(entry.fields)) {
      fields[field] = { required: info.required, sensitive: info.sensitive };
    }
  }
  return {
    block: "needs",
    name: entry.path.join("."),
    fields,
    type: entry.need.type ?? entry.need.kind,
    required: !entry.need.optional,
    readBy: entry.path.length === 1 ? readBy(`resources\0${entry.path[0]}`) : [],
  };
}

function bindingOf(
  root: ResourceManifest,
  block: "variables" | "ports",
  name: string,
  env: string,
): { binding?: { env?: string; arg?: string } } {
  const arg = argumentSynopsisOf(root, block, name);
  if (!env && !arg) return {};
  return { binding: { ...(env ? { env } : {}), ...(arg ? { arg } : {}) } };
}

function typeOf(schema: Record<string, unknown>): { type?: string } {
  const valueType = schema["x-telo-type"];
  if (typeof valueType === "string") return { type: valueType };
  if (valueType && typeof valueType === "object" && typeof (valueType as { name?: unknown }).name === "string") {
    return { type: (valueType as { name: string }).name };
  }
  return typeof schema.type === "string" ? { type: schema.type } : {};
}

/** Every field of the entry module's resources, and of its module doc, whose
 *  expressions read an input: `variables.<x>`, `secrets.<x>`, `ports.<x>`, or
 *  `resources.<x>` for a need or a resource input. */
function readsOf(
  sources: OutlineSources,
  manifestOf: ReadonlyMap<string, ResourceManifest>,
  rootId: string | undefined,
): Map<string, OutlineRead[]> {
  const out = new Map<string, OutlineRead[]>();
  const seen = new Set<string>();
  const callNames = moduleCallNamesByModule(sources.manifests);
  for (const node of sources.graph.nodes) {
    if (node.external || node.ownership === "injected") continue;
    const manifest = node.root ? sources.root : manifestOf.get(node.id);
    if (!manifest) continue;
    const resource = node.root ? (rootId ?? node.id) : node.id;
    const names = moduleCallNamesOf(callNames, manifest);
    walkCelExpressions(manifest, "", (source, path, engine) => {
      for (const chain of celExpressionsOf(engine, source).flatMap((x) => accessChains(x, names))) {
        if (chain.length < 2) continue;
        if (!["variables", "secrets", "ports", "resources"].includes(chain[0]!)) continue;
        const key = `${chain[0]}\0${chain[1]}`;
        const mark = `${key}\0${resource}\0${path}`;
        if (seen.has(mark)) continue;
        seen.add(mark);
        const reads = out.get(key);
        if (reads) reads.push({ resource, path });
        else out.set(key, [{ resource, path }]);
      }
    });
  }
  return out;
}

/** The value at a concrete path (`steps[0].then[1].inputs`). */
function valueAt(manifest: unknown, path: string): unknown {
  let current: unknown = manifest;
  for (const segment of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (current === null || typeof current !== "object") return undefined;
    current = segment.startsWith("[")
      ? (current as unknown[])[Number(segment.slice(1, -1))]
      : (current as Record<string, unknown>)[segment];
  }
  return current;
}
