/**
 * The module graph — what a module IS, as boxes, rows and classed edges.
 *
 * One fold over the call graph, the reference field map and each kind's own
 * schema, producing the three primitives an editor draws:
 *
 *  - **Box** — a declaration and what it owns. Every resource is a node whatever
 *    declaration form it arrived in (named, inline, `with:`-scoped, imported,
 *    injected), plus the module root, which is not a resource but owns `targets`.
 *  - **Row** — one ORDERED entry inside a box: a step, an entry-list item (a
 *    route, a mount), a boot target. Order is manifest data, so it is carried
 *    rather than re-derived; a row is where reordering is expressible at all.
 *  - **Edge** — a reference leaving a PORT, classed by what the slot's `use`
 *    says happens at it.
 *
 * **Ports are declared, not discovered.** A port exists because the kind's
 * schema declares a ref slot, so an EMPTY slot is a port with an empty
 * occupancy — the fact that `notFoundHandler` is unset is as much a property of
 * the application as the fact that `mounts` has two entries, and it is the only
 * thing an editor can offer to fill.
 *
 * **Three edge classes, not six uses.** What a reader must distinguish is
 * whether control transfers, not which of four ways it does:
 * `call` / `detached` / `trigger.inbound` / `trigger.consumer` are **flow**,
 * `dependency` is **holds**, `schema` is **shape** — a type annotation rather
 * than a runtime relation. The six-value `use` stays on the edge for consumers
 * that need the distinction; the class is what a view draws.
 *
 * **Identity is anchored on names, never on indices.** A row addressed by array
 * index shifts when a sibling is inserted above it, so selection and sticky
 * expansion would detach precisely while the user is editing — the primary use
 * case. Where the grammar offers a name (a step's `name:`, a resource's
 * `metadata.name`) the name is the identity; where it does not (an unnamed
 * route, an unnamed step) the identity is the nearest named ancestor plus a
 * content-derived key. The same reason the migration driver refuses indexed
 * matches into a resized array: a stale key resolves to nothing, a stale index
 * silently names a different element.
 *
 * **What is deliberately NOT here: view policy.** Bands, labels, layout and
 * expansion are the editor's, so nothing in this file reads a schema `title` or
 * decides where a node is drawn. What it emits is the fact each of those
 * decisions is taken from — capability, ownership, edge class, `boot` — so two
 * hosts drawing the same module cannot disagree about what it contains.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import {
  buildCelEnvironment,
  extractAccessChains,
  isRefSentinel,
  walkCelExpressions,
} from "@telorun/templating";
import {
  nodeIdFor,
  resolveScopedName,
  resourceId,
  type CallGraph,
  type CallGraphEdge,
  type ResourceGraphNode,
  type StepGraphNode,
} from "./call-graph.js";
import { propertySchemas, resolveLocalRef } from "./manifest-navigation.js";
import { isStepSlot } from "./step-slot.js";
import { isInlineResource, resolveFieldEntries } from "./reference-field-map.js";
import { findZoneProviders } from "./resolve-zone-containment.js";
import { possibleUses, readRefSlot, type RefUse } from "./ref-slot.js";

/** How a node's declaration reached the module, which is what decides where a
 *  view may draw it — an inline child exists nowhere but its parent's YAML, so
 *  it is never a peer of the resource holding it. */
export type NodeOwnership = "root" | "named" | "inline" | "scoped" | "imported" | "injected";

/**
 * What happens at a site, reduced to what a view draws.
 *
 * The first three classify a REFERENCE by its `use`; `data` is not a reference
 * at all — it is one resource reading another's published state in CEL
 * (`resources.<name>.status.<field>`), which is a real dependency the reference
 * graph does not carry and which no slot declares.
 */
export type EdgeClass = "flow" | "holds" | "shape" | "data";

/**
 * What a line of a body is.
 *
 * The first three are ORDERED entries of an array — a step, an entry-list item,
 * a boot target — and reordering one is the point of drawing them. The last two
 * are not positions at all: a slot may hold a DECLARATION rather than a name
 * (`invoke: { kind: …, …config }`), and that declaration exists nowhere but the
 * site, so it has no array to sit in and no sibling to be moved past. It is a
 * line of the body because it is a thing the author wrote and has to be able to
 * reach; see {@link isOrderedRow}.
 */
export type RowKind = "step" | "entry" | "target" | "inline" | "reference";

/**
 * Rows that are ordered entries of their array.
 *
 * A consumer offering reorder, removal or an index must ask — a declaration
 * written at a dispatch site carries an `index` of 0 and an `array` it shares
 * with its host, both of which are borrowed so it groups into the right branch,
 * and neither of which means what it means on a step.
 */
export function isOrderedRow(row: GraphRow): boolean {
  return row.kind === "step" || row.kind === "entry" || row.kind === "target";
}

/** One occupancy of a port: the concrete site, and the name it holds. */
export interface PortSlot {
  /** Concrete path of this site (`mounts[1].mount`), the write target. */
  path: string;
  /** Referenced resource name, absent for an empty slot. */
  target?: string;
  /** Node id the name resolves to, absent when it resolves to nothing. */
  targetNode?: string;
  /** The site holds an inline declaration rather than a reference; `targetNode`
   *  is the extracted child. */
  inline?: boolean;
}

/** A reference slot the kind declares, filled or not. */
export interface GraphPort {
  /** Field-map path with `[]` / `{}` markers — the port's identity on its node. */
  slot: string;
  /** Accepted `x-telo-ref` constraints, canonicalized. */
  refs: string[];
  /** Capabilities a target may satisfy — what validates a wire. */
  capabilities: string[];
  /** The slot traverses at least one array, so it takes many targets. */
  array: boolean;
  class: EdgeClass;
  slots: PortSlot[];
  /** Concrete path a new array item would be written at. Array ports only. */
  addPath?: string;
  /** This slot's occupancy is drawn as ROWS rather than as port slots — the
   *  slot sits inside a step body or an entry list, where order is semantic and
   *  the row is the thing a reader manipulates. */
  rowOwned?: boolean;
}

/** One ordered entry inside a box. */
export interface GraphRow {
  /** Name-anchored identity, stable across insertion of a sibling. */
  id: string;
  kind: RowKind;
  /** What the manifest calls this line: a step's `name:`, or — for a
   *  `reference` row — the field holding it. Absent where the grammar offers
   *  neither (an unnamed route, an `inline` row, which is named by its kind). */
  name?: string;
  /** Concrete path of the row (`steps[0].do[1]`, `routes[2]`) — the write
   *  target, and what a position index is keyed by. */
  path: string;
  /** Concrete path of the array holding it, the reorder domain. */
  array: string;
  /** Lexical index within that array. */
  index: number;
  /** Nesting depth: 0 at the body's top level, +1 inside each branch. */
  depth: number;
  /** Row id of the enclosing row, when this one nests inside a branch. */
  parent?: string;
  /** Referenced name this row dispatches to, when it dispatches. */
  target?: string;
  /** Node id of that target, when it resolves. */
  targetNode?: string;
  /** JSON Pointer to this call's argument map, when the slot declares one. */
  inputs?: string;
  /** The values a matcher-role field holds (`{path: "/orders", method: "POST"}`)
   *  — what identifies an entry to a reader, and what its content key is
   *  derived from. Entry rows only. */
  match?: Record<string, unknown>;
  /**
   * What this row IS, in the grammar's own words — `invoke`, `if/then/else`,
   * `while/do`, `switch/cases/default`, `try/catch/finally`, `throw`, `value`.
   *
   * Without it every statement in a body reads alike: a loop and a dispatch are
   * both a name and an arrow, so a reader has to open the source to find out
   * which is which. Read off the branch the step matches, so a kind declaring a
   * body of its own is described in the words its author chose.
   */
  variant?: string;
  /** The branch's title as its author wrote it — a label to render, never to
   *  parse. See `StepGraphNode.variantLabel`. */
  variantLabel?: string;
  /**
   * The expression deciding whether or how this row runs, as written — an
   * `if:`, a `while:`, a `switch:`, or a dispatch's `when:` guard.
   *
   * A step drawn without it says it is conditional and not on what, which for a
   * loop is the whole behaviour.
   */
  predicate?: string;
  /** This row declares an error branch — a field the kind annotated
   *  `x-telo-error-context`, which is where a raised code is discharged. Found
   *  by the annotation, so a third-party composer's `catches:` is seen too. */
  catches?: boolean;
  /**
   * Where this row's call is WRITTEN, and what may fill it.
   *
   * A row is the dispatch site a reader manipulates — a step's `invoke:`, a
   * route's `handler:`, a boot target — and until now the site was recoverable
   * only from an edge, so a row dispatching to nothing yet had no address at
   * all. That is exactly the row an editor has something to offer at: it is
   * where a reference is written, and where a new resource would be wired in.
   *
   * Absent for a row that dispatches nothing by grammar (a pure `value:` step)
   * and for a declaration row, which IS the thing dispatched to.
   */
  dispatch?: {
    path: string;
    refs: string[];
    /** The slot holds a DECLARATION written at the site rather than a reference
     *  to one elsewhere. A consumer offers different things at the two: nothing
     *  can be wired into an occupied declaration without destroying it, and a
     *  declaration is the one thing that can be given a name of its own. */
    inline?: boolean;
    /**
     * The row's OTHER sites — the same call, written a different way, under a
     * different constraint.
     *
     * A boot target is the case that forced it: the entry takes a bare
     * `!ref` to a `Telo.Runnable | Telo.Service`, and it takes an invoke step
     * whose `invoke:` takes any `Telo.Executable`. Reporting only the first made
     * every `Telo.Invocable` in the application unbootable from the editor —
     * legal in the manifest, and offered nowhere, since a slot with nothing to
     * put in it reads as an empty module rather than as a missing site.
     *
     * Primary first, and a site is listed once per CONSTRAINT: a boot target's
     * `ref:` accepts exactly what its bare form does, so the two are one site
     * and the bare spelling wins. Which spelling to write is a choice a reader
     * should not have to make, and the constraint is the only thing that
     * changes what may be written at all.
     */
    alternatives?: { path: string; refs: string[] }[];
  };
  /** `inline` rows: the kind the declaration written at this site names. A
   *  declaration is not a reference — there is nothing elsewhere to point at,
   *  which is the whole reason the row has to carry its own identity. */
  declares?: string;
  /** That kind resolved to no definition. */
  unknownKind?: boolean;
}

/** A resource, the module root, or a declaration owned by either. */
export interface GraphNode {
  /** `<kind>\0<name>` for a module-level resource — the call graph's own id, so
   *  a consumer holding one can address the other. */
  id: string;
  kind: string;
  name: string;
  /** Declared capability, absent when the kind does not resolve — an unresolved
   *  import, a kind with no definition. A view must render it as unknown rather
   *  than guessing a placement it would have to take back. */
  capability?: string;
  /**
   * `<module>.<Kind>` — what `kind` NAMES, resolved.
   *
   * `kind` is the string the author wrote, and it is written in the DECLARING
   * module's alias scope: a library declares its own instances as
   * `kind: Self.WriteLine`, and `Self` means that library. Carried into a
   * flattened application the spelling survives and resolves to nothing there,
   * so every consumer joining on a kind — does this slot accept it, which
   * instances does this kind have, what schema does the form use — silently
   * missed a whole imported library.
   *
   * Absent when the kind is already canonical, and when it resolves to nothing
   * (which `unknownKind` says).
   */
  canonicalKind?: string;
  /** The kind resolved to no definition at all. */
  unknownKind?: boolean;
  ownership: NodeOwnership;
  /** Node that owns this declaration — set for `inline` and `scoped`. */
  owner?: string;
  /** Site on the owner that declares it (`/with`, `mounts[0].mount`). */
  ownerSite?: string;
  /** Module that declared it, when stamped. */
  module?: string;
  /** True when the declaring module is not the entry module — an instance
   *  reached across an import boundary. */
  external?: boolean;
  /** Import alias the entry module reaches it under, when it is external and
   *  one alias points at its module. What a boundary box is labelled by, and
   *  what a reference to it is written with. */
  alias?: string;
  ports: GraphPort[];
  rows: GraphRow[];
  /**
   * The ordered arrays this kind can hold rows in, whether or not any exist.
   *
   * Declared rather than observed, for the same reason a port is: a server with
   * no mounts still HAS mounts, and a canvas that lists only what is there
   * offers no way to add the first one. Each is a field name plus what its rows
   * would be.
   */
  rowArrays: { field: string; kind: RowKind }[];
  /** What invoking this can raise, resolved along its own call graph — the
   *  error contract a caller has to render or let escape. `unbounded` means the
   *  union could not be closed statically, so a catch-all is required. */
  throws?: { codes: string[]; unbounded: boolean };
  /** The module root, which owns `targets` and the module's own config. */
  root?: boolean;
}

/** A reference site, classed. */
export interface GraphEdge {
  /** Stable within the graph: source, slot and site. */
  id: string;
  /** Node id of the declaring resource — never a step, since a step is a ROW of
   *  its owner here rather than a node. `row` says which row declared it. */
  from: string;
  /** Node id of the target, absent when the name resolves to nothing. */
  to?: string;
  /** The referenced name as written, always present — a `!ref` to a name that
   *  does not exist is a real edge some other pass reports, and dropping it
   *  would make the graph disagree with the manifest about what was written. */
  toName: string;
  class: EdgeClass;
  /** The declared uses at this site, unreduced. */
  use: RefUse[];
  /** Field-map path of the slot — part of the edge's identity, so two slots
   *  naming one target are two edges. */
  slot: string;
  /** Concrete path of the site. */
  path: string;
  /** Row this edge leaves from, when a row declares it. */
  row?: string;
  /** JSON Pointer to this call's argument map, when declared. */
  inputs?: string;
  /** The edge is a boot target of the module root: ordered, and the reason the
   *  target runs at all. */
  boot?: boolean;
  /** The target is declared inside the source's own scope. */
  scoped?: boolean;
  /** Data edges only: the access chain as written (`resources.db.status.port`),
   *  so a reader is told WHAT is read rather than only that something is. */
  read?: string;
}

/**
 * A genuine containment: a set of nodes something else encloses.
 *
 * Reference reachability is NOT containment — that mistake is what drew a mount
 * as a child of its server while the slot said `dependency`. The three that ARE:
 * an **inline** declaration and a **scope**'s resources exist nowhere but their
 * owner's YAML, and a **zone** is a region of execution every dispatch inside it
 * runs within.
 */
export interface GraphRegion {
  id: string;
  kind: "inline" | "scope" | "zone";
  /** Node whose declaration encloses the members. */
  owner: string;
  /** Site on the owner (`/with`, `invoke`, `steps`). */
  site: string;
  /** Node ids inside. */
  members: string[];
  /** Zone regions only: what the region GUARANTEES about its contents, as the
   *  declaring kind wrote it — the attribute name mapped to the author's
   *  reason, which a consumer quotes rather than paraphrases. */
  attributes?: Readonly<Record<string, string>>;
  /** Zone regions only: dispatches inside the region the zone does NOT extend
   *  through — a detached call, an inbound trigger. Recorded because the site is
   *  inside the region even though its target is not. */
  boundaries?: { from: string; toName: string; escaping: string[] }[];
}

/**
 * A kind declaration — the second plane.
 *
 * Kept apart from the instance nodes rather than mixed in: a `Telo.Definition`
 * is a TYPE, and drawing it among the instances would put things that exist at
 * runtime and things that do not on one surface with nothing separating them.
 * A module that declares only kinds has this plane and no other, which is why
 * it is a first-class list rather than a flag on a node.
 */
export interface GraphKind {
  /** Canonical `<module>.<Name>` — what a `kind:` resolves to. */
  id: string;
  name: string;
  module?: string;
  /** Non-instantiable: the contract has no default implementation. */
  abstract: boolean;
  capability?: string;
  /** Canonical id of the kind this one specializes, when it resolves. */
  extendsId?: string;
  /** The `extends` target as WRITTEN, kept when it resolves to nothing — an
   *  unresolved parent is a fact about the manifest, not a reason to draw the
   *  kind as having none. */
  extendsName?: string;
  /** Ids of the instance nodes declared of this kind — the join between the
   *  two planes. */
  instances: string[];
  /** Declares a body of its own (`resources:` / `invoke:` / `run:` / `provide:`)
   *  rather than naming a controller — the kind's interior. */
  template: boolean;
  /** Declared by the entry module rather than reached through an import. */
  own: boolean;
  /** Listed in the entry module's `exports.kinds`, so an importer may construct
   *  one. Undefined for a kind this module did not declare, whose gate is its
   *  own library's to state. */
  exported?: boolean;
}

export interface ModuleGraph {
  /** The module root, when one was supplied. */
  root?: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  regions: GraphRegion[];
  /** The kind plane — every kind declaration in scope. */
  kinds: GraphKind[];
  nodeById(id: string): GraphNode | undefined;
  edgesFrom(id: string): GraphEdge[];
  edgesTo(id: string): GraphEdge[];
}

/**
 * A hold whose target is ambient infrastructure — the collapse candidate.
 *
 * Stated here rather than in the view because it is the rule the plan fixes,
 * and two hosts applying it differently would disagree about which edges exist:
 * a hold into a shared connection or store is fan-in that swamps a layout and
 * carries no structure, while a hold BETWEEN working resources is the
 * application's spine — a server holding its mounts — and demoting the second
 * with the first is exactly the mistake this replaces.
 */
/**
 * Is anything reaching this declaration at all?
 *
 * "Declared, referenced by nothing, in no `targets`" — the resource a reader
 * cannot otherwise tell apart from a wired one, since a manifest states no
 * difference between the two. Every incoming edge counts, not only flow: a
 * connection is HELD rather than called, and reading it as unwired would mark
 * every provider in the module. An owned declaration is reached by its owner,
 * and the root is what reaches everything else.
 *
 * A declaration this module did not write is NEVER unwired, however little it
 * is used here. An imported library exports what it exports, and the flatten
 * forwards all of it; "nothing references this" would be a true sentence about
 * an unused export and a useless one, since the reader cannot act on it — the
 * declaration is not theirs to remove.
 */
export function isUnwired(node: GraphNode, graph: ModuleGraph): boolean {
  if (node.root || node.external) return false;
  if (node.ownership === "inline" || node.ownership === "scoped") return false;
  return graph.edgesTo(node.id).length === 0;
}

export function isAmbientHold(edge: GraphEdge, graph: ModuleGraph): boolean {
  if (edge.class !== "holds" || !edge.to) return false;
  const target = graph.nodeById(edge.to);
  return isAmbientCapability(target?.capability);
}

/**
 * Capabilities whose resources are AMBIENT: held and read, never run, and never
 * drawn as the target of a line.
 *
 * Exported because the view partitions on the same fact — which boxes go off
 * the canvas into the drawer — and two spellings of it is how a host ends up
 * collapsing a hold the other still draws an edge for.
 */
export const AMBIENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "Telo.Provider",
  "Telo.Type",
]);

/** Is this an ambient declaration — held and read rather than run? */
export function isAmbientCapability(capability: string | undefined): boolean {
  return !!capability && AMBIENT_CAPABILITIES.has(capability);
}

/** Uses that transfer control, so the site is drawn as flow. */
const FLOW_USES: ReadonlySet<string> = new Set([
  "call",
  "detached",
  "trigger.inbound",
  "trigger.consumer",
]);

/**
 * The class a site is drawn as.
 *
 * A slot declaring NO use reads as flow, the same conservative direction the
 * call graph takes: the cost of a false "control reaches here" is an edge drawn
 * more prominently than it deserved, while the cost of a false "it never does"
 * is a call the picture denies exists.
 */
export function edgeClassOf(use: readonly RefUse[]): EdgeClass {
  if (use.length === 0) return "flow";
  if (use.some((u) => FLOW_USES.has(u))) return "flow";
  if (use.includes("dependency" as RefUse)) return "holds";
  return "shape";
}

/** What the projection needs from a registry, as a structural contract — so it
 *  folds over stubs in tests and over the real registry in a host, and so this
 *  module imports no registry class. */
export interface ModuleGraphDeps {
  /** Every reference slot a resource's kind declares, filled or not. */
  refFields(resource: ResourceManifest): {
    path: string;
    isArray: boolean;
    refs: string[];
    capabilities: string[];
  }[];
  /** The resource's definition, resolved in its declaring module's scope. */
  definition(kind: string, module?: string): ResourceDefinition | undefined;
  /** What invoking this resource can raise. Optional: a host without the
   *  resolver gets nodes with no error contract rather than a wrong one. */
  throwsOf?(manifest: ResourceManifest): { codes: string[]; unbounded: boolean } | undefined;
  /** Import aliases pointing at a module, so a reference written across the
   *  boundary as `!ref <Alias>.<name>` resolves to the instance it names. The
   *  call graph resolves bare names only — correct for a name declared here,
   *  and the reason every cross-module reference otherwise reads as dangling. */
  aliasesForModule(module: string): string[];
}

export interface BuildModuleGraphOptions {
  /** The module doc (`Telo.Application` / `Telo.Library`), which is not a
   *  resource but owns `targets` and is the boot root. */
  root?: ResourceManifest;
  /** Module name of the entry module, so an instance declared elsewhere is
   *  marked external rather than being told apart by a heuristic. */
  entryModule?: string;
}

/**
 * Documents that declare a TYPE or a module rather than an instance.
 *
 * The flattened analysis carries every imported library's definitions beside
 * its instances, so without this the instance plane fills with the abstracts a
 * dependency happens to declare (`Sql.Connection`, `Codec.Encoder`) — boxes for
 * things that never exist at runtime, drawn among the things that do. They are
 * the kind plane's, which is a separate surface. The module docs are here too:
 * the entry module's is minted as the ROOT, and an imported library's is not an
 * instance at all.
 */
const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  "Telo.Definition",
  "Telo.Abstract",
  "Telo.Import",
  "Telo.Application",
  "Telo.Library",
]);

const moduleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

/** The canonical id of a resolved kind definition — where it was declared plus
 *  what it is called there, which is the one spelling every module agrees on. */
const canonicalKindOf = (definition: ResourceDefinition | undefined): string | undefined => {
  const metadata = definition?.metadata as { module?: string; name?: string } | undefined;
  if (!metadata?.name) return undefined;
  return metadata.module ? `${metadata.module}.${metadata.name}` : metadata.name;
};

const originOf = (
  manifest: ResourceManifest,
): { parentKind: string; parentName: string; pathFromParent: string } | undefined =>
  (
    manifest.metadata as
      | { xTeloOrigin?: { parentKind: string; parentName: string; pathFromParent: string } }
      | undefined
  )?.xTeloOrigin;

const isForwardedExport = (manifest: ResourceManifest): boolean =>
  (manifest.metadata as { forwardedExport?: boolean } | undefined)?.forwardedExport === true;

const isInjected = (manifest: ResourceManifest): boolean =>
  (manifest.metadata as Record<string, unknown> | undefined)?.["xTeloInjected"] === true;

/**
 * A short, stable key over a value's shape.
 *
 * FNV-1a over canonical JSON: what is wanted is that the same written entry
 * keeps the same identity when a sibling is inserted above it, which a hash of
 * the entry's own content gives and an index cannot. Collisions are resolved by
 * declaration order at the call site, so two byte-identical rows stay
 * distinguishable without either one's identity depending on the other's
 * position.
 */
export function contentKey(value: unknown): string {
  const json = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Mints ids that are unique without being positional: the name where one
 *  exists, a content key where none does, and a `~n` suffix only when two
 *  siblings are genuinely indistinguishable. */
class IdMinter {
  private readonly used = new Set<string>();

  mint(base: string): string {
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}~${n}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }
}

/** The schema node at a field-map path, following `[]` into `items` and `{}`
 *  into `additionalProperties`, resolving local `$ref`s along the way. */
function schemaAt(
  rootSchema: Record<string, any> | undefined,
  slotPath: string,
): Record<string, any> | undefined {
  if (!rootSchema) return undefined;
  let current: Record<string, any> | undefined = rootSchema;
  for (const segment of slotPath.split(".")) {
    if (!current) return undefined;
    // A map's key step is its OWN segment (`columns.{}.type`), where an array's
    // rides the field it belongs to (`mounts[].mount`). Reading only the suffix
    // form walked into nothing at the first map, so every slot under one was
    // left with no schema — and a slot with no schema declares no `use`, which
    // classed a column's typed reference as a control transfer.
    if (segment === "{}") {
      current = resolveLocalRef(
        current.additionalProperties as Record<string, any> | undefined,
        rootSchema,
      );
      continue;
    }
    const bare = segment.replace(/(\[\]|\{\})+$/g, "");
    let next: Record<string, any> | undefined = propertySchemas(current).find(
      ([k]) => k === bare,
    )?.[1];
    for (const marker of segment.slice(bare.length).match(/\[\]|\{\}/g) ?? []) {
      next = resolveLocalRef(
        marker === "[]"
          ? (next?.items as Record<string, any> | undefined)
          : (next?.additionalProperties as Record<string, any> | undefined),
        rootSchema,
      );
      if (!next || typeof next !== "object") return undefined;
    }
    current = resolveLocalRef(next, rootSchema);
  }
  return current;
}

/** Every array field of a kind carrying `x-telo-topology-role: entries`, with
 *  the roles declared inside its items — `matcher` fields identify an entry to
 *  a reader, `handler` fields say what it dispatches to. No kind is named: a
 *  third-party router declaring the same three tokens renders identically. */
interface EntryListSpec {
  field: string;
  matchers: string[];
  handlers: string[];
  /** Sub-fields annotated `x-telo-error-context` — where an entry discharges a
   *  raised code. */
  errorBranches: string[];
}

/**
 * Does this field hold the branch that DISCHARGES a raised error?
 *
 * Two annotations mark one, from two layers, and both are read: the shared CEL
 * one (`x-telo-error-context`, which types the `error` variable inside a
 * `catch:`) and the dispatch outcome vocabulary (`x-telo-outcome-list: catches`,
 * which an HTTP-style router uses to render a code as a response). Neither is a
 * field NAME, so a third-party composer spelling its branch differently is seen
 * as long as it annotates it; recognizing only one would silently mark every
 * route in the standard library as handling nothing.
 */
function isErrorBranch(schema: Record<string, any> | undefined): boolean {
  return (
    schema?.["x-telo-error-context"] !== undefined ||
    schema?.["x-telo-outcome-list"] === "catches"
  );
}

function entryListsOf(rootSchema: Record<string, any> | undefined): EntryListSpec[] {
  if (!rootSchema) return [];
  const out: EntryListSpec[] = [];
  for (const [key, propSchema] of propertySchemas(rootSchema)) {
    if (propSchema?.["x-telo-topology-role"] !== "entries") continue;
    const items = resolveLocalRef(propSchema.items as Record<string, any>, rootSchema);
    const matchers: string[] = [];
    const handlers: string[] = [];
    const errorBranches: string[] = [];
    for (const [subKey, subSchema] of propertySchemas(items ?? {})) {
      const role = subSchema?.["x-telo-topology-role"];
      if (role === "matcher") matchers.push(subKey);
      else if (role === "handler") handlers.push(subKey);
      if (isErrorBranch(subSchema)) errorBranches.push(subKey);
    }
    out.push({ field: key, matchers, handlers, errorBranches });
  }
  return out;
}

/** A value written AT a ref slot that declares a resource rather than naming
 *  one — `{kind, …config}` with no `name`. */
function isInlineDeclaration(value: unknown): boolean {
  if (isRefSentinel(value) || !value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // The shape test itself is the field map's — one reader for "is this a
  // declaration rather than a reference", since the extraction pass keys on the
  // same answer and a second opinion here would decide differently the day the
  // form gains a key.
  return isInlineResource(value as Record<string, unknown>);
}

/** The referenced name a ref value carries, across both written forms: an
 *  unresolved `!ref <name>` sentinel and the `{kind, name}` object
 *  `resolveRefSentinels` rewrites it into. */
function refName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (!value || typeof value !== "object") return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Fold a manifest set into the module graph.
 *
 * The call graph supplies what calls what — including the scoped nodes and step
 * bodies it already discovers — and this pass adds what a picture needs and a
 * call graph has no reason to carry: declared-but-empty ports, ownership,
 * ordered rows, region membership, and the reduction of six uses to three
 * classes.
 */
export function buildModuleGraph(
  resources: ResourceManifest[],
  callGraph: CallGraph,
  deps: ModuleGraphDeps,
  options: BuildModuleGraphOptions = {},
): ModuleGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const regions: GraphRegion[] = [];
  const byId = new Map<string, GraphNode>();
  const rowIdByPath = new Map<string, string>();
  /** References found inside inline declarations, resolved once every node
   *  exists — a declaration may name a resource declared later in the file. */
  const inlineEdgeSeeds = new Map<string, InlineEdgeSeed[]>();

  const add = (node: GraphNode): GraphNode => {
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  };

  // --- the module root -------------------------------------------------------
  // Not a resource: it owns `targets` and the module's own configuration, and
  // the call graph deliberately skips it. Minting it here is what makes a boot
  // target an ordinary edge rather than a fact a consumer has to fetch from
  // somewhere else.
  let root: GraphNode | undefined;
  if (options.root) {
    const name = (options.root.metadata?.name as string | undefined) ?? "";
    const module = moduleOf(options.root);
    root = add({
      id: resourceId(options.root.kind as string, name),
      kind: options.root.kind as string,
      name,
      ownership: "root",
      ...(module ? { module } : {}),
      ports: [],
      rows: [],
      // Boot targets are an ordered list the root always has, empty or not.
      rowArrays: [{ field: "targets", kind: "target" }],
      root: true,
    });
  }

  // --- resource nodes --------------------------------------------------------
  // Minted from the MANIFEST LIST, not from the call graph's node map.
  //
  // The call graph keys a resource by `(kind, name)`, which is unique within one
  // module and not across a flattened set: two libraries each exporting an
  // `Http.Api` named `routes` collapse onto one node there, and a picture built
  // from that map draws one box for two declarations. Minting here from the
  // manifests keeps both, qualified by their declaring module. What is still the
  // call graph's — steps and edges — is translated through `projectedId`, and
  // the collapsed twin's own edges are missing from it; its ports and rows are
  // read from its manifest here, so the box is drawn and wired correctly and
  // only the edges the call graph lost are absent.
  // One id scheme, the call graph's — a resource name is module-scoped, so the
  // module is part of the identity wherever one is stamped. Stating it here a
  // second way is how the two halves would disagree about which box an edge
  // arrives at.
  const idOf = (manifest: ResourceManifest): string => nodeIdFor(manifest);

  const manifestById = new Map<string, ResourceManifest>();
  for (const manifest of resources) {
    const name = manifest.metadata?.name;
    if (typeof name !== "string" || !manifest.kind || DECLARATION_KINDS.has(manifest.kind)) continue;
    if (root && manifest === options.root) continue;
    const id = idOf(manifest);
    if (byId.has(id)) continue;
    add(projectResource(id, manifest, deps, options));
    manifestById.set(id, manifest);
  }

  // Call-graph node id → the node it designates here, so a step or an edge the
  // call graph produced lands on the box this pass minted.
  const projectedId = new Map<string, string>();
  const scopedIdByKey = new Map<string, string>();
  const scopedByOwner = new Map<string, Map<string, string[]>>();
  for (const graphNode of callGraph.nodes.values()) {
    if (graphNode.type !== "resource") continue;
    if (DECLARATION_KINDS.has(graphNode.kind)) continue;
    if (graphNode.scoped) {
      // A `with:`-scoped resource is declared inside another's body, so it is in
      // no manifest list of its own — the call graph is where it exists.
      //
      // One declaration, one box: the call graph keys a scoped node by the
      // scope POINTER, and `x-telo-scope` lists every region a scoped name
      // resolves in (`Run.Sequence` names both `/steps` and `/targets`), so one
      // `with:` entry arrives once per pointer. The pointers say where the name
      // is visible, not where the resource was declared.
      const key = `${graphNode.scopeOwner ?? ""}#scope#${resourceId(graphNode.kind, graphNode.name)}`;
      const already = scopedIdByKey.get(key);
      if (already) {
        projectedId.set(graphNode.id, already);
        continue;
      }
      const node = add(projectResource(graphNode.id, graphNode.manifest, deps, options));
      scopedIdByKey.set(key, node.id);
      node.ownership = "scoped";
      if (graphNode.scopeOwner) node.owner = graphNode.scopeOwner;
      if (graphNode.scopeSite) node.ownerSite = graphNode.scopeSite;
      manifestById.set(node.id, graphNode.manifest);
      projectedId.set(graphNode.id, node.id);
      const owner = graphNode.scopeOwner;
      if (owner) {
        const sites = scopedByOwner.get(owner) ?? new Map<string, string[]>();
        const site = graphNode.scopeSite ?? "";
        sites.set(site, [...(sites.get(site) ?? []), node.id]);
        scopedByOwner.set(owner, sites);
      }
      continue;
    }
    projectedId.set(graphNode.id, idOf(graphNode.manifest));
  }
  // A scoped node's owner is a call-graph id; translate it now that every
  // resource node has one.
  for (const node of nodes) {
    if (node.ownership === "scoped" && node.owner) {
      node.owner = projectedId.get(node.owner) ?? node.owner;
    }
  }
  for (const [owner, sites] of [...scopedByOwner]) {
    const translated = projectedId.get(owner);
    if (translated && translated !== owner) {
      scopedByOwner.delete(owner);
      scopedByOwner.set(translated, sites);
    }
  }

  // Inline children: the extraction stamps the parent and the path it was
  // written at, so ownership is read off the declaration rather than guessed
  // from a name pattern. The stamp names the parent by `(kind, name)`, so it is
  // translated through the same table a call-graph id is.
  const inlineByOwner = new Map<string, Map<string, string[]>>();
  for (const node of nodes) {
    if (node.ownership !== "inline" || !node.owner) continue;
    node.owner = projectedId.get(node.owner) ?? node.owner;
    const sites = inlineByOwner.get(node.owner) ?? new Map<string, string[]>();
    const site = node.ownerSite ?? "";
    sites.set(site, [...(sites.get(site) ?? []), node.id]);
    inlineByOwner.set(node.owner, sites);
  }

  for (const [owner, sites] of inlineByOwner) {
    for (const [site, members] of sites) {
      regions.push({ id: `${owner}#inline:${site}`, kind: "inline", owner, site, members });
    }
  }
  for (const [owner, sites] of scopedByOwner) {
    for (const [site, members] of sites) {
      regions.push({ id: `${owner}#scope:${site}`, kind: "scope", owner, site, members });
    }
  }

  // Execution zones: a region every dispatch inside runs within. Read from the
  // containment walk rather than re-derived, so what the editor draws and what
  // `telo check` enforces are the same region — including one declaring no
  // attributes, which is still a zone.
  for (const zone of findZoneProviders(callGraph, (kind, module) => deps.definition(kind, module))) {
    const owner = projectedId.get(zone.provider.id) ?? zone.provider.id;
    if (!byId.has(owner)) continue;
    const members: string[] = [];
    for (const [id, contained] of zone.contents) {
      // A step is a ROW of its owner here, so a zone reaching one is a zone
      // reaching the resource whose body declares it.
      const memberId =
        contained.node.type === "step"
          ? (projectedId.get(contained.node.owner) ?? contained.node.owner)
          : (projectedId.get(id) ?? id);
      if (memberId !== owner && byId.has(memberId) && !members.includes(memberId)) {
        members.push(memberId);
      }
    }
    const boundaries = zone.boundaries.map((b) => ({
      from: projectedId.get(b.from.id) ?? b.from.id,
      toName: b.edge.toName,
      escaping: b.escaping,
    }));
    regions.push({
      id: `${owner}#zone:${zone.slot}`,
      kind: "zone",
      owner,
      site: zone.slot,
      members,
      attributes: zone.attributes,
      ...(boundaries.length > 0 ? { boundaries } : {}),
    });
  }

  // --- rows ------------------------------------------------------------------
  // Steps come from the call graph, which owns the analyzer's only step-array
  // recursion; entry lists and boot targets are read here, since neither is a
  // step body and neither has a node of its own.
  const callGraphIdByNode = invertProjectedIds(projectedId);
  const callGraphIdOf = (nodeId: string): string => callGraphIdByNode.get(nodeId) ?? nodeId;

  for (const node of nodes) {
    const manifest = node.root ? options.root : manifestById.get(node.id);
    if (!manifest) continue;
    const definition = deps.definition(node.kind, node.module);
    const schema = definition?.schema as Record<string, any> | undefined;
    // The root's rows are its BOOT LIST and nothing else. `targets` carries the
    // step grammar, so the call graph mints a step node for every entry that is
    // not a bare `!ref` — and `targetRows` already renders every shape an entry
    // takes, so collecting both listed an inline target twice.
    node.rows = node.root
      ? targetRows(node, manifest, rowIdByPath)
      : [
          ...stepRows(node, callGraph, callGraphIdOf(node.id), rowIdByPath),
          ...entryRows(node, manifest, schema, rowIdByPath),
        ];
    if (!node.root) node.rowArrays = declaredRowArrays(schema);
  }

  // --- ports and edges -------------------------------------------------------
  for (const node of nodes) {
    const manifest = node.root ? options.root : manifestById.get(node.id);
    if (!manifest) continue;
    const definition = deps.definition(node.kind, node.module);
    const schema = definition?.schema as Record<string, any> | undefined;
    // A slot whose occupancy is DRAWN AS ROWS is not also a port: a route, a
    // boot target and a step are manipulated as the ordered thing they are, and
    // a second rendering of the same occupancy beside it is two controls for
    // one fact. Read off the DECLARED arrays, not the rows: an empty `mounts`
    // would otherwise be row-owned only once it had a mount in it, so a fresh
    // server showed both a port and an add control for the same list.
    const rowArrays = new Set(node.rowArrays.map((a) => a.field));
    node.ports = buildPorts(manifest, deps, schema, rowArrays);
    const throws = deps.throwsOf?.(manifest);
    if (throws && (throws.codes.length > 0 || throws.unbounded)) node.throws = throws;
    // A declaration written at a dispatch site hangs under the row that
    // declares it — see `inlineRows`. After the ports, because a route's
    // `handler:` is a port slot and its occupancy is what names the site; and
    // woven rather than appended, so the body stays pre-order, which every
    // consumer of `parent` relies on.
    node.rows = weaveInlineRows(
      node,
      manifest,
      callGraph,
      callGraphIdOf(node.id),
      deps,
      rowIdByPath,
      inlineEdgeSeeds,
    );
  }

  // Alias-qualified names, so a reference across an import boundary resolves.
  // The call graph matches bare names — right for a name declared here, and the
  // reason `!ref Console.writeLine` reached this pass as a dangling edge.
  // Every row is known by now, so the per-owner index the longest-prefix walk
  // needs is built once rather than re-scanned per edge.
  const rowsByOwner = rowsByOwnerOf(rowIdByPath);

  const byQualifiedName = new Map<string, string>();
  for (const node of nodes) {
    if (!node.module) continue;
    for (const alias of deps.aliasesForModule(node.module)) {
      const key = `${alias}.${node.name}`;
      if (!byQualifiedName.has(key)) byQualifiedName.set(key, node.id);
    }
  }

  // Edges come from the call graph — one per site, already resolved — re-keyed
  // onto the boxes a view draws: a step's edge is attributed to the resource
  // whose body declares it, with the row that declared it named, because a step
  // is a row here rather than a node of its own.
  for (const edge of callGraph.edges) {
    const projected = projectEdge(
      edge,
      callGraph,
      byId,
      rowIdByPath,
      rowsByOwner,
      byQualifiedName,
      projectedId,
    );
    if (!projected) continue;
    // A reference leaving the module root IS a boot target — the root has no
    // other slots — so the flag is stamped here rather than by a second pass
    // over `targets`, which emitted a duplicate edge for every one of them.
    if (root && projected.from === root.id) projected.boot = true;
    edges.push(projected);
  }

  // Data edges: one resource reading another's published state in CEL. Parsed,
  // never scanned — `extractAccessChains` reads `resources.db.status.port` as a
  // chain and a name inside a string literal as nothing, which a token scan
  // cannot tell apart.
  // A bare name resolves in the module that WROTE it — the call graph's own
  // rule, shared rather than restated. Keeping a first-wins index here would
  // have put every inline declaration's reference and every CEL state read back
  // on whichever module happened to come first in the flattened list, which is
  // the collision module-scoped identity exists to prevent.
  const nodesByName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.root) continue;
    nodesByName.set(node.name, [...(nodesByName.get(node.name) ?? []), node]);
  }
  const resolveName = (name: string, fromModule: string | undefined): string | undefined =>
    resolveScopedName(nodesByName.get(name), (node) => node.module, fromModule)?.id;

  // References written INSIDE a declaration. Resolved here rather than where
  // they were found, because a declaration may name a resource declared later
  // in the file — and against the same name index every other edge uses, so a
  // hold reached through an inline declaration counts exactly as one written at
  // a named resource's own slot.
  for (const [from, list] of inlineEdgeSeeds) {
    const fromModule = byId.get(from)?.module;
    for (const seed of list) {
      const to = resolveName(seed.toName, fromModule) ?? byQualifiedName.get(seed.toName);
      const edge: GraphEdge = {
        id: `${from}\0${seed.path}`,
        from,
        toName: seed.toName,
        class: edgeClassOf(seed.uses),
        use: seed.uses,
        slot: seed.slot,
        path: seed.path,
        row: seed.rowId,
      };
      if (to) edge.to = to;
      edges.push(edge);
    }
  }

  for (const node of nodes) {
    const manifest = node.root ? options.root : manifestById.get(node.id);
    if (!manifest) continue;
    edges.push(...dataEdges(node, manifest, node.module, resolveName, rowIdByPath, rowsByOwner));
  }

  // Where each row's call is WRITTEN, and what may fill it — see
  // `GraphRow.dispatch`. Three shapes, because the grammar has three: a step's
  // slot is declared on its item schema and reachable only through the step
  // walk; an entry's is a row-owned port of the array it sits in; a boot target
  // IS its own slot. All three are stated even when nothing fills them, since
  // an empty site is exactly the one an editor has something to offer at.
  for (const node of nodes) {
    const stepSlots = new Map<string, GraphRow["dispatch"]>();
    const stepSites = new Map<string, { path: string; refs: string[] }[]>();
    for (const step of callGraph.steps(callGraphIdOf(node.id))) {
      const first = step.refSlots?.[0];
      if (first) {
        stepSlots.set(step.path, {
          path: first.path,
          refs: first.kinds,
          ...(first.inline ? { inline: true } : {}),
        });
      }
      if (step.refSlots?.length) {
        stepSites.set(
          step.path,
          step.refSlots.map((slot) => ({ path: slot.path, refs: slot.kinds })),
        );
      }
    }
    // Whether a port-derived site holds a declaration, by its concrete path.
    const inlineAt = new Set(
      node.ports.flatMap((port) => port.slots.filter((s) => s.inline).map((s) => s.path)),
    );
    const rowOwnedPorts = node.ports.filter((port) => port.rowOwned);
    for (const row of node.rows) {
      if (row.kind === "step") {
        const slot = stepSlots.get(row.path);
        if (slot) {
          row.dispatch = withAlternatives(slot, stepSites.get(row.path) ?? []);
        }
        continue;
      }
      if (row.kind === "target") {
        const port = node.ports.find((p) => p.slot === `${row.array}[]`);
        if (port) {
          row.dispatch = withAlternatives(
            {
              path: row.path,
              refs: port.refs,
              ...(inlineAt.has(row.path) ? { inline: true } : {}),
            },
            // A boot target IS a step, and the step walk is what sees the sites
            // the entry's own grammar declares — the bare reference the port
            // reports is one spelling of one of them.
            stepSites.get(row.path) ?? [],
          );
        }
        continue;
      }
      if (row.kind !== "entry") continue;
      // `routes[].handler` → the handler of THIS route, whether or not one is
      // written: the port's own slots list only the routes that have one.
      const port = rowOwnedPorts.find((p) => containerArrayOf(p.slot) === row.array);
      if (port) {
        const path = `${row.path}.${port.slot.slice(port.slot.indexOf("[].") + 3)}`;
        row.dispatch = {
          path,
          refs: port.refs,
          ...(inlineAt.has(path) ? { inline: true } : {}),
        };
      }
    }
  }

  // Back-fill what a row learns from the edge it declares: where its target
  // resolved, and where this call's arguments are written. Both are the edge's
  // to know — a row is read off the manifest, while `inputs` is a POINTER the
  // slot declares and the target is a name the graph resolved — so they are
  // stamped here rather than guessed twice.
  const rowById = new Map<string, GraphRow>();
  for (const node of nodes) for (const row of node.rows) rowById.set(row.id, row);
  for (const edge of edges) {
    const row = edge.row ? rowById.get(edge.row) : undefined;
    if (!row) continue;
    if (edge.to && row.targetNode === undefined) row.targetNode = edge.to;
    if (row.target === undefined) row.target = edge.toName;
    if (edge.inputs !== undefined && row.inputs === undefined) {
      // The pointer is relative to the object ENCLOSING the slot, which for a
      // step or an entry is the row itself.
      row.inputs = `${row.path}${edge.inputs.replace(/\//g, ".")}`;
    }
  }

  const fromIndex = new Map<string, GraphEdge[]>();
  const toIndex = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    fromIndex.set(edge.from, [...(fromIndex.get(edge.from) ?? []), edge]);
    if (edge.to) toIndex.set(edge.to, [...(toIndex.get(edge.to) ?? []), edge]);
  }

  return {
    root,
    nodes,
    edges,
    regions,
    kinds: buildKindPlane(resources, nodes, deps, options),
    nodeById: (id) => byId.get(id),
    edgesFrom: (id) => fromIndex.get(id) ?? [],
    edgesTo: (id) => toIndex.get(id) ?? [],
  };
}

/**
 * The call-graph id a projected node came from — the reverse of `projectedId`.
 *
 * Built ONCE. Inverting the map per lookup was a linear scan inside three
 * per-node loops, so a module of n boxes paid O(n²) three times over on every
 * keystroke.
 */
function invertProjectedIds(projectedId: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [callGraphId, projected] of projectedId) {
    if (!out.has(projected)) out.set(projected, callGraphId);
  }
  return out;
}

function projectResource(
  id: string,
  manifest: ResourceManifest,
  deps: ModuleGraphDeps,
  options: BuildModuleGraphOptions,
): GraphNode {
  const module = moduleOf(manifest);
  const kind = manifest.kind as string;
  const definition = deps.definition(kind, module);
  const origin = originOf(manifest);

  const node: GraphNode = {
    id,
    kind,
    name: manifest.metadata?.name as string,
    ownership: "named",
    ports: [],
    rows: [],
    rowArrays: [],
  };
  if (definition?.capability) node.capability = definition.capability as string;
  const canonical = canonicalKindOf(definition);
  if (canonical && canonical !== kind) node.canonicalKind = canonical;
  if (!definition) node.unknownKind = true;
  if (module) node.module = module;

  if (origin) {
    node.ownership = "inline";
    node.owner = resourceId(origin.parentKind, origin.parentName);
    node.ownerSite = origin.pathFromParent;
  } else if (isInjected(manifest)) {
    node.ownership = "injected";
  } else if (isForwardedExport(manifest)) {
    node.ownership = "imported";
  }

  // External is a fact about the DECLARING module, not about the ownership
  // class: a library's own named resource forwarded into an app is `imported`,
  // while a resource the app declares in an included partial is not — both are
  // decided by the module stamp rather than by how the reference reached here.
  if (options.entryModule && module && module !== options.entryModule) {
    node.external = true;
    // The alias the reference is WRITTEN with. Several may point at one module;
    // the first is taken, because a boundary box needs one label and every
    // alias designates the same module.
    const alias = module ? deps.aliasesForModule(module)[0] : undefined;
    if (alias) node.alias = alias;
  }

  return node;
}

/** Step rows, from the call graph's step nodes. Depth and parent come from the
 *  nesting the call graph already recorded; identity is re-anchored on names. */
function stepRows(
  node: GraphNode,
  callGraph: CallGraph,
  callGraphId: string,
  rowIdByPath: Map<string, string>,
): GraphRow[] {
  const steps = callGraph.steps(callGraphId);
  if (steps.length === 0) return [];
  const minter = new IdMinter();
  const idByStepPath = new Map<string, string>();
  const rows: GraphRow[] = [];

  for (const step of steps) {
    const parentId = step.parent ? idByStepPath.get(step.parent) : undefined;
    const anchor = parentId ? `${parentId}/` : `${node.id}#step:`;
    const key = step.name ?? `@${contentKey(step.step)}`;
    const id = minter.mint(`${anchor}${key}`);
    idByStepPath.set(step.id, id);
    rowIdByPath.set(`${node.id}\0${step.path}`, id);

    const row: GraphRow = {
      id,
      kind: "step",
      path: step.path,
      array: step.array,
      index: step.index,
      depth: depthOf(step, callGraph, callGraphId),
      ...(step.name !== undefined ? { name: step.name } : {}),
      ...(step.variant !== undefined ? { variant: step.variant } : {}),
      ...(step.variantLabel !== undefined ? { variantLabel: step.variantLabel } : {}),
      ...(step.predicate !== undefined ? { predicate: step.predicate } : {}),
      ...(parentId ? { parent: parentId } : {}),
    };
    rows.push(row);
  }
  return rows;
}

/**
 * One dispatch, with the other ways its grammar lets it be written.
 *
 * Deduplicated by CONSTRAINT, not by path: two spellings accepting the same
 * kinds are one site, and which of them to write is a choice a reader should
 * never be asked to make (the primary is the plainer form). A spelling that
 * accepts something the primary cannot is a site of its own, because it is the
 * only address a reference to such a target could be written at.
 */
function withAlternatives(
  primary: NonNullable<GraphRow["dispatch"]>,
  sites: readonly { path: string; refs: string[] }[],
): NonNullable<GraphRow["dispatch"]> {
  const key = (refs: readonly string[]) => [...refs].sort().join("\u0000");
  const seen = new Set([key(primary.refs)]);
  const alternatives: { path: string; refs: string[] }[] = [];
  for (const site of sites) {
    if (site.path === primary.path || seen.has(key(site.refs))) continue;
    seen.add(key(site.refs));
    alternatives.push(site);
  }
  return alternatives.length > 0 ? { ...primary, alternatives } : primary;
}

/**
 * The rows and edges a DECLARATION written at a dispatch site contributes.
 *
 * `invoke: { kind: Sql.Command, connection: !ref chatDb }` is a resource the
 * manifest genuinely declares, and until now the graph could see none of it: no
 * node, no edge, and a step row identical to one that dispatches nothing. The
 * hold was invisible too, so a connection reached only from inside inline
 * declarations was reported as referenced by nothing.
 *
 * What is emitted is one row for the declaration — named by its kind, addressed
 * at the site, so it can be opened and edited where it was written — and one row
 * per reference it fills, each carrying a real edge. That is what puts the hold
 * back on the graph, and it is why these are rows rather than a label: a
 * reference needs somewhere for its line to leave from.
 *
 * Recursive, because a declaration may hold another; bounded by the manifest,
 * which cannot contain itself.
 */
function inlineRows(
  node: GraphNode,
  site: { path: string; value: Record<string, unknown> },
  host: { rowId: string; array: string; depth: number; slot: string },
  deps: ModuleGraphDeps,
  rowIdByPath: Map<string, string>,
  out: { rows: GraphRow[]; edges: InlineEdgeSeed[] },
): void {
  const kind = site.value.kind as string;
  const declared = deps.definition(kind, node.module);
  const id = `${host.rowId}/${lastPathSegment(site.path)}`;
  const row: GraphRow = {
    id,
    kind: "inline",
    path: site.path,
    array: host.array,
    index: 0,
    depth: host.depth + 1,
    parent: host.rowId,
    declares: kind,
    ...(declared ? {} : { unknownKind: true }),
  };
  out.rows.push(row);
  rowIdByPath.set(`${node.id}\0${site.path}`, id);

  // The declaration's own reference slots, read through its kind's field map —
  // the same map a named resource's ports come from, so an inline declaration
  // and an extracted one describe themselves identically.
  const asManifest = { ...site.value, metadata: { name: id } } as unknown as ResourceManifest;
  const declaredSchema = declared?.schema as Record<string, any> | undefined;
  for (const field of deps.refFields(asManifest)) {
    for (const entry of resolveFieldEntries(asManifest, field.path)) {
      const path = `${site.path}.${entry.path}`;
      if (isInlineDeclaration(entry.value)) {
        inlineRows(
          node,
          { path, value: entry.value as Record<string, unknown> },
          { rowId: id, array: host.array, depth: row.depth, slot: `${host.slot}.${field.path}` },
          deps,
          rowIdByPath,
          out,
        );
        continue;
      }
      const target = refName(entry.value);
      if (target === undefined) continue;
      const refId = `${id}/${lastPathSegment(entry.path)}`;
      out.rows.push({
        id: refId,
        kind: "reference",
        name: lastPathSegment(field.path),
        path,
        array: host.array,
        index: 0,
        depth: row.depth + 1,
        parent: id,
        target,
      });
      rowIdByPath.set(`${node.id}\0${path}`, refId);
      out.edges.push({
        rowId: refId,
        toName: target,
        // The slot the OWNER declares, so the branch this edge leaves is the
        // host's own property — what decides whether it is drawn at all.
        slot: `${host.slot}.${field.path}`,
        path,
        // Read off the DECLARED kind's own schema, exactly as a port's is —
        // `use` is a property of the slot, and the slot belongs to the kind
        // written here rather than to the resource hosting it.
        uses: readUses(schemaAt(declaredSchema, field.path)),
      });
    }
  }
}

/**
 * The body with each declaration's rows woven in beneath the row that declares
 * it, keeping the whole list pre-order.
 *
 * Pre-order is not a nicety: every consumer of `parent` — the tree's visibility
 * walk, the geometry, the renderer — settles a parent's verdict before it asks
 * about a child, and appending these at the end would silently break all three.
 *
 * Sites come from two places and neither is optional. A STEP's dispatch slot is
 * recorded by the call graph, which is the only walk that reaches a step's item
 * schema; every other slot — a route's `handler:`, a `mounts[].mount` — is an
 * ordinary field-map entry and is found here.
 */
function weaveInlineRows(
  node: GraphNode,
  manifest: ResourceManifest,
  callGraph: CallGraph,
  callGraphId: string,
  deps: ModuleGraphDeps,
  rowIdByPath: Map<string, string>,
  seeds: Map<string, InlineEdgeSeed[]>,
): GraphRow[] {
  /**
   * Sites keyed by their concrete path, because the two walks OVERLAP: a step's
   * `invoke:` is both a step dispatch slot and a row-owned port slot, so
   * collecting them into a list emitted every declaration under a step twice —
   * two rows sharing one id, and two copies of every edge inside it.
   */
  // This node's rows as they stand before any declaration is woven in — which
  // is what a site can be hosted BY. Scoped to the node rather than scanning
  // every row in the module, and taken once because the weave only ADDS rows
  // below the ones a site could already have named.
  const ownRows = rowsByOwnerOf(rowIdByPath).get(node.id) ?? [];

  const sites = new Map<string, { rowId: string; path: string; value: Record<string, unknown>; slot: string }>();
  const record = (rowId: string, path: string, value: unknown, slot: string): void => {
    if (!rowId || sites.has(path) || !isInlineDeclaration(value)) return;
    sites.set(path, { rowId, path, value: value as Record<string, unknown>, slot });
  };

  for (const step of callGraph.steps(callGraphId)) {
    for (const site of (step.refSlots ?? []).filter((slot) => slot.inline)) {
      const rowId = rowIdByPath.get(`${node.id}\0${step.path}`);
      if (!rowId) continue;
      record(rowId, site.path, step.step[site.key], `${step.array}[].${site.key}`);
    }
  }

  for (const port of node.ports) {
    if (!port.slots.some((slot) => slot.inline)) continue;
    for (const entry of resolveFieldEntries(manifest, port.slot)) {
      // A site on a slot no row owns — a plain `connection:` on a resource — is
      // left to the port, which already draws it. Only a ROW can host a subtree.
      const rowId =
        rowIdByPath.get(`${node.id}\0${entry.path}`) ??
        rowAt(new Map([[node.id, ownRows]]), node.id, entry.path);
      if (!rowId) continue;
      record(rowId, entry.path, entry.value, port.slot);
    }
  }

  if (sites.size === 0) return node.rows;

  const byRow = new Map<string, typeof sites extends Map<string, infer V> ? V[] : never>();
  for (const site of sites.values()) {
    byRow.set(site.rowId, [...(byRow.get(site.rowId) ?? []), site]);
  }



  const out: GraphRow[] = [];
  for (const row of node.rows) {
    out.push(row);
    for (const site of byRow.get(row.id) ?? []) {
      const collected = { rows: [] as GraphRow[], edges: [] as InlineEdgeSeed[] };
      inlineRows(
        node,
        { path: site.path, value: site.value },
        { rowId: row.id, array: row.array, depth: row.depth, slot: site.slot },
        deps,
        rowIdByPath,
        collected,
      );
      out.push(...collected.rows);
      if (collected.edges.length > 0) {
        seeds.set(node.id, [...(seeds.get(node.id) ?? []), ...collected.edges]);
      }
    }
  }
  return out;
}

/** A reference found inside a declaration, before its target is resolved. */
interface InlineEdgeSeed {
  rowId: string;
  toName: string;
  slot: string;
  path: string;
  uses: RefUse[];
}

/** `steps[0].invoke.connection` → `connection`; `routes[1]` → `routes`. */
function lastPathSegment(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\d+\]$/, "").replace(/\[\]$|\{\}$/, "");
}

/** Nesting depth of a step: how many step parents stand above it. */
function depthOf(step: StepGraphNode, callGraph: CallGraph, ownerId: string): number {
  let depth = 0;
  let current: StepGraphNode | undefined = step;
  const byId = new Map(callGraph.steps(ownerId).map((s) => [s.id, s] as const));
  while (current?.parent) {
    depth++;
    current = byId.get(current.parent);
  }
  return depth;
}

/** Entry rows: one per item of an `x-telo-topology-role: entries` array. The
 *  matcher fields are what identifies an entry to a reader, so they are also
 *  what its identity is derived from — a route keeps its identity when a route
 *  is inserted above it, and loses it only when its own path or method change,
 *  which is what makes it a different route. */
function entryRows(
  node: GraphNode,
  manifest: ResourceManifest,
  schema: Record<string, any> | undefined,
  rowIdByPath: Map<string, string>,
): GraphRow[] {
  const rows: GraphRow[] = [];
  for (const spec of entryListsOf(schema)) {
    const value = (manifest as Record<string, unknown>)[spec.field];
    if (!Array.isArray(value)) continue;
    const minter = new IdMinter();
    value.forEach((item, index) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      // What IDENTIFIES an entry to a reader is the scalars its matcher holds —
      // a path and a method — not the whole matcher, which for an HTTP route
      // also carries the request schema. Taking the schema would put a row's
      // identity at the mercy of an edit to a property it does not show, so a
      // reader loses their selection by editing something else entirely.
      const match = scalarLeaves(
        Object.fromEntries(spec.matchers.filter((m) => entry[m] !== undefined).map((m) => [m, entry[m]])),
      );
      const key = Object.keys(match).length > 0 ? contentKey(match) : contentKey(entry);
      const path = `${spec.field}[${index}]`;
      const id = minter.mint(`${node.id}#entry:${spec.field}/${key}`);
      rowIdByPath.set(`${node.id}\0${path}`, id);

      const handlerField = spec.handlers.find((h) => entry[h] !== undefined);
      const target = handlerField ? refName(entry[handlerField]) : undefined;
      const catches = spec.errorBranches.some((b) => {
        const value = entry[b];
        return Array.isArray(value) ? value.length > 0 : value !== undefined;
      });
      rows.push({
        id,
        kind: "entry",
        path,
        array: spec.field,
        index,
        depth: 0,
        ...(Object.keys(match).length > 0 ? { match } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(catches ? { catches: true } : {}),
      });
    });
  }
  return rows;
}

/**
 * The scalar leaves of a value, flattened to one map, to a bounded depth.
 *
 * A matcher is whatever the kind declared it to be: a flat `path` / `method`
 * pair on one router, a nested `request:` object on another. Reading the scalars
 * out of it works for both without naming either — and stopping at scalars is
 * what keeps a nested JSON Schema (which is an object all the way down) out of
 * something a reader is meant to recognize the row by.
 */
function scalarLeaves(value: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 2 || !value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === null) continue;
    if (typeof child !== "object") out[key] = child;
    else Object.assign(out, scalarLeaves(child, depth + 1));
  }
  return out;
}

/**
 * The ordered arrays a kind declares — its entry lists and its step bodies.
 *
 * Both are found by annotation (`x-telo-topology-role: entries`, and the shared
 * step-body stamp), so a third-party composer's list is offered the same
 * affordances as `Http.Api`'s routes with no editor change.
 */
function declaredRowArrays(
  schema: Record<string, any> | undefined,
): { field: string; kind: RowKind }[] {
  const out: { field: string; kind: RowKind }[] = [];
  for (const spec of entryListsOf(schema)) out.push({ field: spec.field, kind: "entry" });
  for (const [key, propSchema] of propertySchemas(schema ?? {})) {
    if (isStepSlot(propSchema)) out.push({ field: key, kind: "step" });
  }
  return out;
}

/** Boot rows: the root's `targets`, which is an ordered step list — a later
 *  target reads an earlier one's result — so it is rows, not a set. */
function targetRows(
  node: GraphNode,
  manifest: ResourceManifest,
  rowIdByPath: Map<string, string>,
): GraphRow[] {
  const targets = (manifest as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return [];
  const minter = new IdMinter();
  return targets.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const target =
      refName(entry) ?? refName(record.ref) ?? refName(record.invoke) ?? undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    const key = name ?? target ?? `@${contentKey(entry)}`;
    const path = `targets[${index}]`;
    const id = minter.mint(`${node.id}#target:${key}`);
    rowIdByPath.set(`${node.id}\0${path}`, id);
    return {
      id,
      kind: "target" as const,
      path,
      array: "targets",
      index,
      depth: 0,
      ...(name !== undefined ? { name } : {}),
      ...(target !== undefined ? { target } : {}),
      // A boot target's shapes carry no branch titles, so there is no variant
      // to report — but a GATED one is the same fact a step's `when:` is, and
      // a target drawn without its guard says it always runs.
      ...(guardOf(record) !== undefined ? { predicate: guardOf(record)! } : {}),
    };
  });
}

/** The `when:` guard on a boot target, as written. */
function guardOf(entry: Record<string, unknown>): string | undefined {
  const written = entry.when;
  if (typeof written === "string") return written;
  if (written && typeof written === "object") {
    const source = (written as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return undefined;
}

/** Every declared reference slot as a port, with its occupancy read off the
 *  manifest — so an empty slot is a port with no filled sites rather than an
 *  absence a view has to infer. */
function buildPorts(
  manifest: ResourceManifest,
  deps: ModuleGraphDeps,
  schema: Record<string, any> | undefined,
  rowArrays: ReadonlySet<string>,
): GraphPort[] {
  const fields = deps.refFields(manifest);

  // The `anyOf` sub-shapes of one array-of-refs are ONE slot, not three. A boot
  // target may be written bare, as `{ref, when}` or as an inline invoke step, so
  // the field map lists `targets[]`, `targets[].ref` and `targets[].invoke` —
  // rendering each as its own port offers three sockets for one position and
  // says the module has slots it does not have.
  const arrayRefBases = new Set(
    fields.filter((f) => isArrayOfRefs(f.path)).map((f) => arrayBaseOf(f.path)),
  );

  const ports: GraphPort[] = [];
  for (const field of fields) {
    if ([...arrayRefBases].some((base) => field.path.startsWith(`${base}[].`))) continue;
    const slotSchema = schemaAt(schema, field.path);
    const uses = readUses(slotSchema);
    const slots: PortSlot[] = [];
    for (const { value, path } of resolveFieldEntries(manifest, field.path)) {
      const target = refName(value);
      const slot: PortSlot = { path };
      if (target !== undefined) slot.target = target;
      // A slot holding a declaration rather than a reference is FILLED, and a
      // view that reads only `target` would draw it as an empty socket — the
      // one reading that is wrong in both directions, since it invites filling
      // a slot that is already occupied.
      else if (isInlineDeclaration(value)) slot.inline = true;
      slots.push(slot);
    }

    // **An unwritten slot still has a write site.** Resolving the manifest for
    // `notFoundHandler.invoke` on a server that declares no `notFoundHandler`
    // yields nothing, so the port had no path at all — it rendered as an empty
    // socket that could not be filled, which is worse than not drawing it: it
    // offers an affordance and then refuses. The path IS the site for a slot in
    // no array, so it is synthesized here rather than left to every consumer to
    // reconstruct.
    if (slots.length === 0 && !field.path.includes("[]") && !field.path.includes("{}")) {
      slots.push({ path: field.path });
    }
    const port: GraphPort = {
      slot: field.path,
      refs: field.refs,
      capabilities: field.capabilities,
      array: field.isArray,
      class: edgeClassOf(uses),
      slots,
    };
    const append = appendPathFor(field.path, manifest);
    if (append) port.addPath = append;
    if (rowArrays.has(containerArrayOf(field.path))) port.rowOwned = true;
    ports.push(port);
  }
  return ports;
}

/** A top-level array of direct refs (`targets[]`): the trailing `[]` is the
 *  path's only marker. */
function isArrayOfRefs(path: string): boolean {
  return path.endsWith("[]") && !path.slice(0, -2).match(/\[\]|\{\}/);
}

/** `targets[]` → `targets`. */
function arrayBaseOf(path: string): string {
  return path.slice(0, -2);
}

/**
 * Where a NEW occupancy of this slot would be written.
 *
 * Both array shapes reach here: a direct array of refs (`targets[]` →
 * `targets[2]`) and a ref inside an array of objects (`mounts[].mount` →
 * `mounts[2].mount`). The second was missing, so an `Http.Server` with no mounts
 * offered no way to add one — the port drew an empty rail and the drag had
 * nowhere to land. Undefined for a slot in no array, and for one nested past a
 * single array, where the index of the outer item is not determined by the slot
 * alone.
 */
function appendPathFor(path: string, manifest: ResourceManifest): string | undefined {
  const marker = path.indexOf("[]");
  if (marker === -1) return undefined;
  const array = path.slice(0, marker);
  const suffix = path.slice(marker + 2);
  if (array.includes("{}") || suffix.includes("[]") || suffix.includes("{}")) return undefined;
  const existing = (manifest as Record<string, unknown>)[array];
  return `${array}[${Array.isArray(existing) ? existing.length : 0}]${suffix}`;
}

/** The array a slot's occupancy sits in (`routes[].handler` → `routes`,
 *  `targets[]` → `targets`), or the path itself when it is in no array. */
function containerArrayOf(path: string): string {
  const marker = path.indexOf("[]");
  return marker === -1 ? path : path.slice(0, marker);
}

/**
 * Declared uses at a slot, through the annotation's ONE reader.
 *
 * It used to hand-parse `slotSchema["x-telo-ref"]`, which sees nothing when the
 * annotation sits in a `oneOf` branch — the sanctioned shape for a slot that
 * unions a value with a reference. A column's `type:` is exactly that, so its
 * `use: schema` read as no declared use at all and the slot was classed (and
 * drawn) as a control transfer. `readRefSlot` unions the branches; `possibleUses`
 * folds a case map's arms in, which is what a PORT wants: the port describes the
 * slot, and which arm holds is decided per site by the call graph.
 */
function readUses(slotSchema: Record<string, any> | undefined): RefUse[] {
  const slot = readRefSlot(slotSchema);
  return slot ? possibleUses(slot) : [];
}

/** Re-key one call-graph edge onto the boxes a view draws. A step's edge is
 *  attributed to the resource whose body declares it — a step is a row here,
 *  not a node — with the row named so the edge can dock onto it. */
function projectEdge(
  edge: CallGraphEdge,
  callGraph: CallGraph,
  byId: ReadonlyMap<string, GraphNode>,
  rowIdByPath: ReadonlyMap<string, string>,
  rowsByOwner: ReadonlyMap<string, readonly { path: string; id: string }[]>,
  byQualifiedName: ReadonlyMap<string, string>,
  projectedId: ReadonlyMap<string, string>,
): GraphEdge | undefined {
  const source = callGraph.nodes.get(edge.from);
  const rawFrom = source?.type === "step" ? source.owner : edge.from;
  const fromId = projectedId.get(rawFrom) ?? rawFrom;
  if (!byId.has(fromId)) return undefined;

  const projected: GraphEdge = {
    id: `${fromId}\0${edge.slot}\0${edge.path}`,
    from: fromId,
    toName: edge.toName,
    class: edgeClassOf(edge.use),
    use: edge.use,
    slot: edge.slot,
    path: edge.path,
  };
  const to = edge.to ? (projectedId.get(edge.to) ?? edge.to) : undefined;
  if (to && byId.has(to)) projected.to = to;
  else {
    const qualified = byQualifiedName.get(edge.toName);
    if (qualified) projected.to = qualified;
  }
  if (edge.inputs !== undefined) projected.inputs = edge.inputs;
  if (edge.scoped) projected.scoped = true;

  // The row an edge leaves from: the step that declares it, or the entry whose
  // handler slot holds it. Longest-prefix on the concrete path, so a site
  // nested inside a branch docks onto the row that actually declares it.
  const row = rowIdByPath.get(`${fromId}\0${edge.path}`) ?? rowAt(rowsByOwner, fromId, edge.path);
  if (row) projected.row = row;
  return projected;
}

/** The row whose path is the longest prefix of a site's path. */
function rowAt(
  rowsByOwner: ReadonlyMap<string, readonly { path: string; id: string }[]>,
  ownerId: string,
  path: string,
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const row of rowsByOwner.get(ownerId) ?? []) {
    const inside = path.startsWith(`${row.path}.`) || path.startsWith(`${row.path}[`);
    if (inside && row.path.length > bestLength) {
      best = row.id;
      bestLength = row.path.length;
    }
  }
  return best;
}

/**
 * The rows each box owns, by owner — so finding the row a nested site sits in
 * is a scan of one box's rows rather than of every row in the module.
 *
 * The flat `<owner>\0<path>` map is the right shape for an exact hit and the
 * wrong one for the longest-prefix walk, which is the COMMON case: a step's ref
 * is nested inside the step, so the exact lookup misses and the fallback ran
 * over every row of every box, for every edge and every CEL chain.
 */
function rowsByOwnerOf(
  rowIdByPath: ReadonlyMap<string, string>,
): Map<string, { path: string; id: string }[]> {
  const out = new Map<string, { path: string; id: string }[]>();
  for (const [key, id] of rowIdByPath) {
    // The LAST separator: a node id contains NULs of its own (`kind\0name`, and
    // `module\0kind\0name` across a boundary) while a concrete path contains
    // none, so splitting at the first one takes the kind for the owner and
    // leaves the name glued to the path — an index that matches nothing.
    const marker = key.lastIndexOf("\0");
    if (marker === -1) continue;
    const owner = key.slice(0, marker);
    out.set(owner, [...(out.get(owner) ?? []), { path: key.slice(marker + 1), id }]);
  }
  return out;
}

/** Kinds a definition body declares — the marks of a template rather than a
 *  controller-backed kind. */
const TEMPLATE_FIELDS = ["resources", "invoke", "run", "provide"] as const;

/**
 * The kind plane: every `Telo.Definition` / `Telo.Abstract` in scope, with its
 * lineage and the instances that were declared of it.
 *
 * Built from the same manifest list the instance plane skips them from, so a
 * kind-only library — one whose whole content is declarations — has a plane to
 * render rather than an empty canvas.
 */
function buildKindPlane(
  resources: ResourceManifest[],
  nodes: readonly GraphNode[],
  deps: ModuleGraphDeps,
  options: BuildModuleGraphOptions,
): GraphKind[] {
  const exportedKinds = new Set(
    (((options.root as Record<string, any> | undefined)?.exports?.kinds ?? []) as unknown[]).filter(
      (k): k is string => typeof k === "string",
    ),
  );

  // Keyed on the CANONICAL kind, because that is what a kind's own id is: an
  // instance a library declared as `kind: Self.WriteLine` belongs to
  // `console.WriteLine`, and keying on the written spelling gave every such kind
  // an empty instance list.
  const instancesByKind = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.root) continue;
    const key = node.canonicalKind ?? node.kind;
    instancesByKind.set(key, [...(instancesByKind.get(key) ?? []), node.id]);
  }

  const out: GraphKind[] = [];
  for (const manifest of resources) {
    const docKind = manifest.kind as string;
    if (docKind !== "Telo.Definition" && docKind !== "Telo.Abstract") continue;
    const name = manifest.metadata?.name as string | undefined;
    if (!name) continue;
    const module = moduleOf(manifest);
    const id = module ? `${module}.${name}` : name;
    const record = manifest as unknown as Record<string, unknown>;
    const extendsName = typeof record.extends === "string" ? record.extends : undefined;
    const parent = extendsName ? deps.definition(extendsName, module) : undefined;
    const parentModule = parent ? moduleOf(parent as unknown as ResourceManifest) : undefined;
    const parentName = parent?.metadata?.name as string | undefined;

    const kind: GraphKind = {
      id,
      name,
      abstract: docKind === "Telo.Abstract",
      instances: instancesByKind.get(id) ?? [],
      template: TEMPLATE_FIELDS.some((f) => record[f] !== undefined),
      own: !!options.entryModule && module === options.entryModule,
    };
    if (module) kind.module = module;
    if (typeof record.capability === "string") kind.capability = record.capability;
    if (extendsName) kind.extendsName = extendsName;
    if (parent && parentName) kind.extendsId = parentModule ? `${parentModule}.${parentName}` : parentName;
    // Only the entry module's gate is in hand — an imported library's
    // `exports.kinds` is stamped on the import, not on the definition, so a
    // claim about it here would be a guess.
    if (kind.own) kind.exported = exportedKinds.has(name);
    out.push(kind);
  }
  return out;
}

/** The CEL environment used to PARSE a chain out of an expression. One per
 *  process: building it is the expensive half, and nothing here evaluates. */
let parseEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/** Access chains an expression reads, or none when it does not parse — a syntax
 *  error is the engine pass's to report, not this one's. */
function accessChains(source: string): string[][] {
  try {
    parseEnv ??= buildCelEnvironment();
    return extractAccessChains(parseEnv.parse(source).ast);
  } catch {
    return [];
  }
}

/**
 * Every `resources.<name>…` read in one resource's CEL, as an edge.
 *
 * This is the dependency a manifest states without a slot: a config provider
 * read by five resources has five edges the reference graph cannot show, and an
 * observed-state read is the same shape one level in. Deduplicated per
 * (target, chain), since the same read at two sites is one fact about the pair.
 */
function dataEdges(
  node: GraphNode,
  manifest: ResourceManifest,
  fromModule: string | undefined,
  resolveName: (name: string, fromModule: string | undefined) => string | undefined,
  rowIdByPath: ReadonlyMap<string, string>,
  rowsByOwner: ReadonlyMap<string, readonly { path: string; id: string }[]>,
): GraphEdge[] {
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  walkCelExpressions(manifest, "", (source, path) => {
    for (const chain of accessChains(source)) {
      if (chain[0] !== "resources" || chain.length < 2) continue;
      const targetName = chain[1]!;
      // `resources.<name>` is a bare name written in THIS module's scope, so it
      // resolves the way every other bare name does.
      const to = resolveName(targetName, fromModule);
      if (!to || to === node.id) continue;
      const read = chain.join(".");
      const key = `${to}\0${read}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge: GraphEdge = {
        id: `${node.id}\0data\0${path}\0${read}`,
        from: node.id,
        to,
        toName: targetName,
        class: "data",
        use: [],
        slot: "cel",
        path,
        read,
      };
      const row = rowIdByPath.get(`${node.id}\0${path}`) ?? rowAt(rowsByOwner, node.id, path);
      if (row) edge.row = row;
      out.push(edge);
    }
  });
  return out;
}
