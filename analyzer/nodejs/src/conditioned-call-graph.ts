/**
 * The call graph of every configuration at once: each node and edge with the
 * condition it holds under, read in UNION coordinates — a place is its union
 * keys, a list item keeping the index it is written at whichever items a
 * configuration drops.
 *
 * A declaration is read once per CHAIN of options inside it — the options
 * enclosing one place, innermost last, the empty chain included — and, beside
 * a chain not passing through it, once per option of a choice written at one
 * of its kind's scope fields, whose members every name in its regions reads
 * first. A view takes exactly those options and drops every other choice (a
 * list item it decides is held as `null`, so the indices stand), and the
 * graph builder reads it as a configuration's run would: inline declarations
 * extracted, step lists walked, module calls read. What the view's graph holds
 * at a place is taken from the one view whose chain is the options enclosing
 * that place, so an element is read once per chain, never once per
 * combination of the choices beside it: a declaration holding k independent
 * choices is read 2k + 1 times at most.
 *
 * A target is resolved through the conditioned name index — scope first, then
 * the module — each outcome with where it holds; an inline declaration the
 * view extracted is its holder's own. A whole-application pass reads the
 * result as its own conditions (`conditionWorld`), or at the witness of a
 * branch no configuration takes, forced there (`witnessWorld`); a finding
 * names and places what it is about where a reader decides the choices
 * (`identityBy`, `reportedBy`) — the facts the union world's placement
 * moves a finding about a node by.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import {
  buildCallGraph,
  edgeParityLine,
  nodeIdFor,
  type CallGraphEdge,
  type ResourceGraphNode,
  type StepGraphNode,
} from "./call-graph.js";
import {
  holdingOf,
  isAlternatives,
  takenAt,
  type Alternatives,
  type ChoiceDecider,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Holding,
  type World,
} from "./conditioned-expansion.js";
import type { ConditionedNameIndex, ConditionedOutcome, NamePopulation } from "./conditioned-name-index.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import type { DefinitionRegistry, ReachDecision, VaryingShapeClasses } from "./definition-registry.js";
import { isModuleKind } from "./module-kinds.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { readOrigin } from "./rewrite-synthetic-origins.js";
import { scopeSiteKey, type ScopeSite } from "./scope-address.js";
import { addressOf, importPathOf, importPathThrough } from "./scoped-name-resolver.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { parseKeys, pathText } from "./template-expansion.js";
import { patternKey } from "./reference-reach.js";
import { placeByUnionKeysBy } from "./region-part.js";
import { isAtOrAbove } from "./relation-sites.js";
import type { ConditionedReachSite } from "./reference-reach.js";
import { APP_DOMAIN, lifetimeDomains } from "./call-graph.js";
import { canonicalKindOf, kindIsA } from "./co-referrer-slot.js";
import { instancesInLoadOrder } from "./co-referrers.js";
import type { LoopLogic } from "./dependency-graph.js";
import type { ModuleDocuments } from "./module-documents.js";
import { pointerToPath } from "./resource-rule.js";
import { splitByReads, type WorldReader } from "./world-reader.js";

type Keys = readonly (string | number)[];

/** Where a graph element holds: the conjunction of its holdings, each of
 *  which a forced witness decides by its path. */
export interface HeldAt {
  readonly condition: Condition;
  readonly holdings: readonly Holding[];
}

/** A node of some configuration's graph. */
export interface HeldGraphNode extends HeldAt {
  /** Its identity over every configuration. */
  readonly id: string;
  /** The node as the view's graph holds it. */
  readonly node: ResourceGraphNode | StepGraphNode;
  /** The declaration of the union it is written in, and where. */
  readonly declaration: ConditionedDeclaration;
  readonly keys: Keys;
  /** Where {@link keys} stands in document order. */
  readonly place: readonly number[];
  /** The options the view reading it takes. */
  readonly taken: ReadonlyMap<Alternatives, number>;
  /** For a step, the resource declaring it; for a scope member, the scope it
   *  is declared in. */
  readonly owner?: string;
  readonly site?: ScopeSite;
  /** An inline declaration a run extracts as a declaration of its own, and
   *  how many extractions deep. */
  readonly extracted?: true;
  readonly depth?: number;
}

/** One reading of a declaration: what it normalizes to, and the places it
 *  holds as its own. */
export interface HeldView extends HeldAt {
  readonly declaration: ConditionedDeclaration;
  /** The declaration and each inline declaration it extracts, with its node
   *  id and where it is written. */
  readonly manifests: readonly { readonly manifest: ResourceManifest; readonly id: string; readonly keys: Keys }[];
  /** Whether the place at `keys` of the declaration is this view's: the
   *  options enclosing it are exactly the view's chain. */
  home(keys: Keys): boolean;
  /** Where the place at `keys` stands in document order, as {@link
   *  HeldGraphEdge.rank} orders. */
  orderOf(keys: Keys): number[];
}

/** A CUT POINT of a declaration: a reference site some configuration's
 *  named shapes read differently — a slot only some classes declare, or
 *  slots that differ between them — as one side of a view meets it: where it
 *  is written in the declaration, and its sides. */
interface MetSlot {
  readonly id: string;
  readonly keys: Keys;
  readonly sides: readonly SlotSide[];
}

/** One side of a cut point: the items of its site held together, and where. */
export interface SlotSide {
  readonly held: ReadonlySet<number>;
  readonly condition: Condition;
}

/** One side of a view's cut points: each cut point it takes another side of
 *  than its first, outermost first; every other one it meets on its first. */
interface SlotReading {
  readonly chain: readonly { readonly slot: MetSlot; readonly side: number }[];
}

/**
 * The sides of a conditioned site: each distinct set of its items holding
 * together, with where — one side holding every item where they all hold
 * everywhere. The side holding fewest items first, so a slot only some
 * classes declare is read as written first.
 */
export function slotSides(site: ConditionedReachSite<Condition>, space: ConditionSpace): SlotSide[] {
  const { refs, steps, scopes, schemaFrom } = site.holding;
  const items = [...refs, ...steps, ...scopes, ...schemaFrom];
  if (items.every((condition) => condition === TRUE)) return [{ held: new Set(items.map((_, i) => i)), condition: TRUE }];
  const sides: SlotSide[] = [];
  let remaining = TRUE;
  while (remaining !== FALSE) {
    const at = space.firstAssignment(remaining)!;
    const held = new Set<number>();
    let condition = TRUE;
    items.forEach((item, i) => {
      const holds = space.holds(item, at);
      if (holds) held.add(i);
      condition = space.and(condition, holds ? item : space.not(item));
    });
    sides.push({ held, condition });
    remaining = space.and(remaining, space.not(condition));
  }
  return sides.sort((x, y) => x.held.size - y.held.size);
}

/**
 * How one side of a view decides the reach: a site every class declares
 * alike whole, a cut point on the side `reading` takes of it — its first
 * where `reading` takes none. Each cut point met is recorded in `met`, by
 * where it is written in the declaration `view` names — a declaration
 * extraction drew out found through its origin.
 */
function slotDecision(reading: SlotReading, met: Map<string, MetSlot>, space: ConditionSpace, view: ResourceManifest): ReachDecision<Condition> {
  const placed = new Map<string, Keys>();
  const keysOf = (resource: ResourceManifest): Keys | undefined => {
    const name = resource.metadata?.name as string | undefined;
    const origin = readOrigin(resource);
    if (!origin) return name === view.metadata?.name && resource.kind === view.kind ? [] : undefined;
    const parent = placed.get(origin.parentName);
    if (!parent) return undefined;
    const keys = [...parent, ...(origin.keysFromParent ?? parseKeys(origin.pathFromParent))];
    if (name !== undefined) placed.set(name, keys);
    return keys;
  };
  const sidesOf = new WeakMap<object, SlotSide[]>();
  return (condition, site, resource) => {
    const at = keysOf(resource);
    if (at && at.length === 0 && typeof resource.metadata?.name === "string") placed.set(resource.metadata.name, at);
    if (condition === TRUE || at === undefined) return true;
    let sides = sidesOf.get(site);
    if (!sides) sidesOf.set(site, (sides = slotSides(site, space)));
    if (sides.length === 1) return true;
    const keys = [...at, ...site.keys];
    const id = JSON.stringify(keys);
    if (!met.has(id)) met.set(id, { id, keys, sides });
    const index = [...site.holding.refs, ...site.holding.steps, ...site.holding.scopes, ...site.holding.schemaFrom].indexOf(condition);
    const side = reading.chain.find((each) => each.slot.id === id)?.side ?? 0;
    return sides[side]!.held.has(index);
  };
}

/** How an edge's target is resolved. */
export type TargetRequest =
  /** An inline declaration the same view extracted. */
  | { readonly form: "extracted"; readonly id: string }
  /** A bare name, scope first — among the analysed modules' own declarations,
   *  or every declaration for one a dependency wrote. */
  | {
      readonly form: "name";
      readonly population: NamePopulation;
      readonly name: string;
      readonly module: string | undefined;
      readonly within?: ScopeSite;
      readonly importPath?: readonly string[];
    }
  /** A name another module declares, through an alias written in `source`. */
  | {
      readonly form: "alias";
      readonly alias: string;
      readonly name: string;
      readonly module: string | undefined;
      readonly importPath: readonly string[];
    }
  /** A module call through the declaring module's own names. */
  | { readonly form: "call"; readonly name: string; readonly module: string | undefined }
  /** A co-referrer a `callsCoReferrers` edge (`via`) reaches: the declaration
   *  `id`, wherever `via` and its edge at the call's slot (`referrer`) both name
   *  `target`. */
  | {
      readonly form: "coReferrer";
      readonly via: HeldGraphEdge;
      readonly referrer: HeldGraphEdge;
      readonly target: string;
      readonly id: string;
    }
  /** Nothing this graph resolves. */
  | { readonly form: "none" };

/** An edge of some configuration's graph. */
export interface HeldGraphEdge extends HeldAt {
  /** The edge as the view's graph holds it — `from` and `to` are the view's. */
  readonly edge: CallGraphEdge;
  /** The node it leaves (a resource or a step) and the resource declaring it. */
  readonly from: string;
  readonly owner: string;
  readonly declaration: ConditionedDeclaration;
  /** The place of its site in the declaration. */
  readonly keys: Keys;
  readonly target: TargetRequest;
  /** Its place among the edges its owner holds, in the order a run adds them. */
  readonly rank: readonly number[];
  /** What tells it from its owner's other edges across views. */
  readonly identity: string;
}

/** One outcome of an edge's target and where it holds. */
export interface HeldTarget<T> {
  /** The node it reaches, undefined for none. */
  readonly to: string | undefined;
  /** Whether that node is a scope member. */
  readonly scoped: boolean;
  readonly held: T;
}

export interface ConditionedCallGraphInputs {
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  /** The top-level fields of a holder's kind declaring a scope. */
  readonly scopeFieldsOf: (holder: ResourceManifest) => readonly string[];
  /** Runs a graph build with the named shapes some configuration varies
   *  registered, every option kept. */
  readonly withShapes: <T>(build: () => T) => T;
  /** The named shapes some configuration varies, as their classes: a
   *  reference slot one declares is a cut point of the declaration, read once
   *  per side of it. */
  readonly varying?: VaryingShapeClasses<Condition>;
  /** Every imported library's full documents — the order a library instance's
   *  declarations are read in. */
  readonly libraries?: readonly ModuleDocuments[];
  /** While dependency parity is observed: the configurations the graph's
   *  parity lines are emitted over. */
  readonly parity?: Condition;
}

/** A graph's edge and incoming parity lines where `condition` holds. */
export interface GraphParityPart {
  readonly condition: Condition;
  readonly edges: readonly string[];
  readonly incoming: readonly string[];
}

/** How graph elements hold, in the connectives `logic` computes in: under
 *  conditions over every configuration, or at one witness. */
export interface GraphWorld<T> {
  readonly logic: LoopLogic<T>;
  at(element: HeldAt): T;
  targets(edge: HeldGraphEdge): HeldTarget<T>[];
  /** The edges reaching node `id`, in the order a run's graph lists them. */
  incoming(id: string): { edge: HeldGraphEdge; held: T }[];
}

/** One option a view takes. */
interface Taken {
  readonly alternatives: Alternatives;
  readonly option: number;
}

/** The options enclosing one place, innermost last, and where they hold. */
interface Chain {
  readonly taken: readonly Taken[];
  readonly holdings: readonly Holding[];
  readonly condition: Condition;
}

const ABSENT = Symbol("absent");

/** The id of a scope member over every configuration: its scope and itself. */
export function scopedMemberId(site: ScopeSite, kind: string, name: string): string {
  return `scoped\0${scopeSiteKey(site)}\0${kind}\0${name}`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Every chain of options inside `root`, the empty one first. */
function chainsOf(root: unknown, space: ConditionSpace, base: Holding): Chain[] {
  const out: Chain[] = [{ taken: [], holdings: [base], condition: base.condition }];
  const visit = (value: unknown, chain: Chain, seen: Set<object>): void => {
    if (isAlternatives(value)) {
      value.options.forEach((option, index) => {
        if (!option.present) return;
        const next: Chain = {
          taken: [...chain.taken, { alternatives: value, option: index }],
          holdings: [...chain.holdings, holdingOf(option)],
          condition: space.and(chain.condition, option.condition),
        };
        out.push(next);
        visit(option.value, next, seen);
      });
      return;
    }
    if (value === null || typeof value !== "object" || isRefSentinel(value) || isTaggedSentinel(value) || isCompiledValue(value)) {
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const member of Array.isArray(value) ? value : Object.values(value)) visit(member, chain, seen);
    seen.delete(value);
  };
  visit(root, out[0]!, new Set());
  return out;
}

/** `root` with the options of `taken` taken and every other choice dropped —
 *  a list item one decides held as `null`. */
export function viewOf(root: unknown, taken: ReadonlyMap<Alternatives, number>): unknown {
  const resolve = (value: unknown): unknown => {
    if (isAlternatives(value)) {
      const index = taken.get(value);
      if (index === undefined) return ABSENT;
      const option = value.options[index]!;
      return option.present ? resolve(option.value) : ABSENT;
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      value.forEach((item, i) => {
        const resolved = resolve(item);
        const held = resolved === ABSENT ? null : resolved;
        if (held !== item) (copy ??= [...value])[i] = held;
      });
      return copy ?? value;
    }
    if (!isPlainObject(value)) return value;
    let copy: Record<string, unknown> | undefined;
    for (const key of Object.keys(value)) {
      const member = value[key];
      const resolved = resolve(member);
      if (resolved === member) continue;
      copy ??= { ...value };
      if (resolved === ABSENT) delete copy[key];
      else copy[key] = resolved;
    }
    return copy ?? value;
  };
  return resolve(root);
}

/** The choices enclosing the place at `keys` of `root` under `taken`, in
 *  order; undefined where the view does not hold the place. */
export function choicesOnTheWay(root: unknown, keys: Keys, taken: ReadonlyMap<Alternatives, number>): Alternatives[] | undefined {
  const out: Alternatives[] = [];
  let node = root;
  const settle = (): boolean => {
    while (isAlternatives(node)) {
      const index = taken.get(node);
      if (index === undefined) return false;
      out.push(node);
      const option = node.options[index]!;
      if (!option.present) return false;
      node = option.value;
    }
    return true;
  };
  for (const key of keys) {
    if (!settle()) return undefined;
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
    if (node === undefined) return undefined;
  }
  return settle() ? out : undefined;
}

/** Where the place at `keys` stands in document order: at each object its
 *  member's index, at each list its item's, at a choice the option taken. */
function documentOrder(root: unknown, keys: Keys, taken: ReadonlyMap<Alternatives, number>): number[] {
  const out: number[] = [];
  let node = root;
  for (const key of keys) {
    while (isAlternatives(node)) {
      const index = taken.get(node) ?? 0;
      out.push(index);
      node = node.options[index]?.value;
    }
    if (Array.isArray(node)) {
      out.push(Number(key));
      node = node[Number(key)];
    } else if (node !== null && typeof node === "object") {
      out.push(Object.keys(node).indexOf(String(key)));
      node = (node as Record<string, unknown>)[String(key)];
    } else {
      out.push(-1);
    }
  }
  return out;
}

/** The order a run adds the edges of one resource in: steps', reference
 *  sites', module calls'. */
const STEP_EDGES = 0;
const REFERENCE_EDGES = 1;
const MODULE_CALLS = 2;

export class ConditionedCallGraph {
  readonly nodes: readonly HeldGraphNode[];
  readonly edges: readonly HeldGraphEdge[];
  /** Every reading, a `Telo.Import`'s included. */
  readonly views: readonly HeldView[];
  private readonly byId = new Map<string, HeldGraphNode>();
  private readonly fromIndex = new Map<string, HeldGraphEdge[]>();
  private readonly byFrom = new Map<string, HeldGraphEdge[]>();
  private readonly stepIndex = new Map<string, HeldGraphNode[]>();
  /** Where each node a run's graph files at module scope stands among its nodes. */
  private readonly nodeOrders = new Map<string, readonly number[]>();
  private incomingIndex: Map<string, HeldGraphEdge[]> | undefined;
  private readonly runKeys = new Map<HeldGraphEdge, readonly number[]>();

  /** While dependency parity is observed: the edge and incoming parity lines,
   *  each with the configurations it holds in. */
  readonly parity?: readonly GraphParityPart[];

  constructor(
    private readonly union: ConditionedExpansion,
    private readonly names: ConditionedNameIndex,
    private readonly scope: Pick<ConditionedCallGraphInputs, "defs" | "aliases" | "aliasesByModule" | "varying">,
    nodes: HeldGraphNode[],
    edges: HeldGraphEdge[],
    views: HeldView[],
    parityOver?: Condition,
  ) {
    this.nodes = nodes;
    this.edges = edges;
    this.views = views;
    const declarationIndex = new Map([...union.declarations, ...union.views].map((d, i) => [d as object, i]));
    const viewCount = union.declarations.length;
    for (const node of nodes) {
      if (!this.byId.has(node.id)) this.byId.set(node.id, node);
      if (node.node.type === "step" && node.owner !== undefined) {
        const list = this.stepIndex.get(node.owner) ?? [];
        list.push(node);
        this.stepIndex.set(node.owner, list);
      }
      if (node.node.type !== "resource" || node.site || this.nodeOrders.has(node.id)) continue;
      // Declarations in the union's order, then what extraction draws out of
      // them, by depth — as a run's graph lists its nodes.
      const index = declarationIndex.get(node.declaration) ?? 0;
      const view = index >= viewCount ? 1 : 0;
      this.nodeOrders.set(node.id, node.extracted ? [view * 2 + 1, node.depth ?? 1, index, ...node.place] : [view * 2, index]);
    }
    for (const list of this.stepIndex.values()) list.sort((a, b) => compareRanks(a.place, b.place));
    for (const edge of edges) {
      const list = this.fromIndex.get(edge.owner) ?? [];
      list.push(edge);
      this.fromIndex.set(edge.owner, list);
    }
    for (const list of this.fromIndex.values()) {
      list.sort((a, b) => compareRanks(a.rank, b.rank));
      for (const edge of list) {
        const from = this.byFrom.get(edge.from) ?? [];
        from.push(edge);
        this.byFrom.set(edge.from, from);
      }
    }
    if (parityOver !== undefined) this.parity = this.parityLines(parityOver);
  }

  /** The module-scope resource nodes, in the order a run's graph lists them. */
  resourceNodes(): HeldGraphNode[] {
    return [...this.nodeOrders.keys()]
      .sort((a, b) => compareRanks(this.nodeOrders.get(a)!, this.nodeOrders.get(b)!))
      .map((id) => this.byId.get(id)!);
  }

  /** Every reading of node `id` — one per view holding it at home. */
  readingsOf(id: string): HeldGraphNode[] {
    return this.nodes.filter((node) => node.id === id);
  }

  /** The step nodes a resource declares, in lexical order. */
  stepsOf(owner: string): readonly HeldGraphNode[] {
    return this.stepIndex.get(owner) ?? [];
  }

  /** The edges leaving node `from` — a resource or a step — in the order a run adds them. */
  edgesFrom(from: string): readonly HeldGraphEdge[] {
    return this.byFrom.get(from) ?? [];
  }

  /** Every edge some outcome of which reaches `id`, in the order a run's graph
   *  lists the edges reaching a node. */
  edgesTo(id: string): readonly HeldGraphEdge[] {
    if (!this.incomingIndex) {
      const index = new Map<string, HeldGraphEdge[]>();
      for (const edge of this.edges) {
        for (const to of new Set(this.outcomes(edge).map((o) => o.to))) {
          if (to === undefined) continue;
          const list = index.get(to) ?? [];
          list.push(edge);
          index.set(to, list);
        }
      }
      for (const list of index.values()) list.sort((a, b) => compareRanks(this.runKey(a), this.runKey(b)));
      this.incomingIndex = index;
    }
    return this.incomingIndex.get(id) ?? [];
  }

  /** Every edge, in the order a run's graph lists its edges. */
  edgesInRunOrder(): readonly HeldGraphEdge[] {
    return (this.runOrder ??= [...this.edges].sort((a, b) => compareRanks(this.runKey(a), this.runKey(b))));
  }

  private runOrder: HeldGraphEdge[] | undefined;

  /** Where an edge stands in a run's graph's edge list: every step edge, then
   *  per declaration its scope members' edges — each member's references, its
   *  steps', then its own members' — and its references, then every module
   *  call, then every co-referrer edge, in the order of the edge calling it. */
  private runKey(edge: HeldGraphEdge): readonly number[] {
    const known = this.runKeys.get(edge);
    if (known) return known;
    let key: number[];
    const request = edge.target;
    const category = edge.rank[1] ?? 0;
    if (request.form === "coReferrer") {
      key = [3, ...this.runKey(request.via), edge.rank[edge.rank.length - 1] ?? 0];
    } else {
      const owner = this.byId.get(edge.owner);
      const members: HeldGraphNode[] = [];
      let top = owner;
      while (top?.site && top.owner !== undefined) {
        members.unshift(top);
        top = this.byId.get(top.owner);
      }
      const order = (top && this.nodeOrders.get(top.id)) ?? [];
      if (members.length > 0) {
        const member = members[members.length - 1]!;
        key = [1, ...order, 0, ...member.place, -1, category === STEP_EDGES ? 1 : 0, ...edge.rank];
      } else if (category === STEP_EDGES) key = [0, ...order, ...edge.rank];
      else if (category === MODULE_CALLS) key = [2, ...order, ...edge.rank];
      else key = [1, ...order, 1, ...edge.rank];
    }
    this.runKeys.set(edge, key);
    return key;
  }

  /** How the graph holds under conditions over every configuration. */
  conditionWorld(): GraphWorld<Condition> {
    const { space } = this.union;
    return {
      logic: {
        TRUE,
        FALSE,
        and: (a, b) => space.and(a, b),
        or: (a, b) => space.or(a, b),
        not: (a) => space.not(a),
        isFalse: (a) => a === FALSE,
      },
      at: (element) => element.condition,
      targets: (edge) => this.targets(edge),
      incoming: (id) =>
        this.edgesTo(id).flatMap((edge) => {
          let held = FALSE as Condition;
          for (const target of this.targets(edge)) if (target.to === id) held = space.or(held, target.held);
          return held === FALSE ? [] : [{ edge, held }];
        }),
    };
  }

  /** How the graph holds at `witness`, a branch no configuration takes forced there. */
  witnessWorld(witness: World): GraphWorld<boolean> {
    return {
      logic: {
        TRUE: true,
        FALSE: false,
        and: (a, b) => a && b,
        or: (a, b) => a || b,
        not: (a) => !a,
        isFalse: (a) => !a,
      },
      at: (element) => this.holdsAt(element, witness),
      targets: (edge) => {
        const target = this.targetAt(edge, witness);
        return target ? [target] : [];
      },
      incoming: (id) =>
        this.edgesTo(id).flatMap((edge) => (this.targetAt(edge, witness)?.to === id ? [{ edge, held: true }] : [])),
    };
  }

  get space(): ConditionSpace {
    return this.union.space;
  }

  node(id: string): HeldGraphNode | undefined {
    return this.byId.get(id);
  }

  /** The edges a resource declares — its own and its steps' — in the order a
   *  run adds them. */
  edgesOf(owner: string): readonly HeldGraphEdge[] {
    return this.fromIndex.get(owner) ?? [];
  }

  /** Where the member `member` of the object `node` stands at is written: one
   *  holding list per way it is there — none where it never is, an empty one
   *  where it is wherever the node is. */
  memberHoldings(node: HeldGraphNode, member: string): Holding[][] {
    let value: unknown = node.declaration.manifest;
    for (const key of [...node.keys, member]) {
      while (isAlternatives(value)) value = value.options[node.taken.get(value) ?? 0]?.value;
      if (value === null || typeof value !== "object") return [];
      value = (value as Record<string | number, unknown>)[key];
    }
    if (value === undefined) return [];
    if (!isAlternatives(value)) return [[]];
    return value.options.filter((option) => option.present).map((option) => [holdingOf(option)]);
  }

  /** A resource node as a run's graph holds it where `decide` decides its
   *  choices: its kind, its name — an extracted one's as that run's extraction
   *  gives it — and its manifest. */
  identityBy(id: string, decide: ChoiceDecider): { kind: string; name: string; manifest: ResourceManifest } {
    const held = this.byId.get(id)!;
    const manifest = this.manifestOf(id);
    if (held.extracted) return { kind: manifest.kind as string, name: this.extractedNameBy(held, decide), manifest };
    if (held.keys.length > 0) {
      const node = held.node as ResourceGraphNode;
      return { kind: node.kind, name: node.name, manifest };
    }
    return { kind: manifest.kind as string, name: manifest.metadata?.name as string, manifest };
  }

  /** A resource node's manifest, a scope member's stamped with its holder's
   *  module — whichever way its choices are decided. */
  manifestOf(id: string): ResourceManifest {
    const held = this.byId.get(id)!;
    if (held.keys.length === 0) return held.declaration.manifest;
    const node = held.node as ResourceGraphNode;
    if (held.extracted) return node.manifest;
    // A scope member is its holder module's declaration.
    const module = (held.declaration.manifest.metadata as { module?: string } | undefined)?.module;
    const own = (node.manifest.metadata as { module?: string } | undefined)?.module;
    return own !== undefined || module === undefined
      ? node.manifest
      : ({ ...node.manifest, metadata: { ...node.manifest.metadata, module } } as ResourceManifest);
  }

  /** The projected path of the place at `keys` of node `id`'s declaration,
   *  relative to the node, where `decide` decides the choices on the way. */
  relativePathBy(id: string, keys: Keys, decide: ChoiceDecider): string {
    const held = this.byId.get(id)!;
    const at = placeByUnionKeysBy(this.union, held.declaration, keys, decide).at;
    const own = held.keys.length === 0 ? [] : placeByUnionKeysBy(this.union, held.declaration, held.keys, decide).at;
    return pathText(at.slice(own.length));
  }

  /** Where a run reports a finding at the projected `path` of resource node
   *  `id`, where `decide` decides the choices on the way: a declaration of the
   *  union at its own, anything written inside one — extracted, or a scope
   *  member — at its place in that declaration. */
  reportedBy(id: string, path: string, decide: ChoiceDecider): { resource: { kind: string; name: string }; filePath: string | undefined; path: string } {
    const held = this.byId.get(id)!;
    const root = held.declaration.manifest;
    const prefix = held.keys.length === 0 ? "" : pathText(placeByUnionKeysBy(this.union, held.declaration, held.keys, decide).at);
    return {
      resource: { kind: root.kind as string, name: root.metadata?.name as string },
      filePath: (root.metadata as { source?: string } | undefined)?.source,
      path: prefix === "" ? path : path === "" ? prefix : `${prefix}.${path}`,
    };
  }

  /** The name a run's extraction gives an inline declaration where `decide`
   *  decides its declaration's choices. */
  private extractedNameBy(held: HeldGraphNode, decide: ChoiceDecider): string {
    const { declaration } = held;
    const projected = this.union.projectBy(declaration.manifest, decide).value as ResourceManifest;
    const { defs, aliases, aliasesByModule, varying } = this.scope;
    const extract = () => normalizeInlineResources([projected], defs, aliases, aliasesByModule);
    // A slot a varying named shape declares is one where `decide` holds it.
    const normalized = varying ? defs.withDecidedReach(varying, (condition) => decide.taken({ condition, path: [] }), extract) : extract();
    const byName = new Map(normalized.map((m) => [m.metadata?.name as string, m]));
    const placeOf = (m: ResourceManifest): Keys | undefined => {
      if (m === normalized[0]) return [];
      const origin = readOrigin(m);
      const parent = origin ? byName.get(origin.parentName) : undefined;
      const at = parent && parent !== m ? placeOf(parent) : undefined;
      return at && origin ? [...at, ...(origin.keysFromParent ?? parseKeys(origin.pathFromParent))] : undefined;
    };
    const at = pathText(placeByUnionKeysBy(this.union, declaration, held.keys, decide).at);
    let name: string | undefined;
    for (const m of normalized) {
      const place = placeOf(m);
      if (place && place.length > 0 && pathText(place) === at) name = m.metadata?.name as string;
    }
    return name ?? ((held.node as ResourceGraphNode).manifest.metadata?.name as string);
  }

  /** The edge and incoming parity lines over `over`, each part of it read
   *  once, as a parity check compares them with a run's graph. */
  private parityLines(over: Condition): GraphParityPart[] {
    const world = this.conditionWorld();
    return splitByReads(this.union.space, over, (read) => ({ edges: this.edgeLinesBy(read), incoming: this.incomingLinesBy(read, world) })).map(
      ({ condition, value }) => ({ condition, ...value }),
    );
  }

  private parityIdentity(id: string, read: ChoiceDecider): string {
    const node = this.identityBy(id, read);
    return `${node.kind} ${node.name} ${(node.manifest.metadata as { module?: string } | undefined)?.module ?? ""}`;
  }

  /** Every edge holding where `read` reads with each target it reaches there. */
  private edgeLinesBy(read: WorldReader<Condition>): string[] {
    const identity = (id: string | undefined): string | undefined =>
      id === undefined ? undefined : this.byId.has(id) ? this.parityIdentity(id, read) : `? ${id}`;
    const out: string[] = [];
    for (const edge of this.edges) {
      if (!read.holds(edge.condition)) continue;
      for (const target of this.targets(edge)) {
        if (!read.holds(target.held)) continue;
        out.push(edgeParityLine(identity(edge.owner)!, { ...edge.edge, path: this.relativePathBy(edge.owner, edge.keys, read) }, identity(target.to)));
      }
    }
    return out.sort();
  }

  /** The edges reaching each node holding where `read` reads, in the order
   *  the graph lists them. */
  private incomingLinesBy(read: WorldReader<Condition>, world: GraphWorld<Condition>): string[] {
    const groups: string[][] = [];
    const seen = new Set<string>();
    for (const node of this.nodes) {
      if (node.node.type !== "resource" || seen.has(node.id)) continue;
      if (!this.readingsOf(node.id).some((r) => r.holdings.every((h) => read.holds(h.condition)))) continue;
      seen.add(node.id);
      const to = this.parityIdentity(node.id, read);
      groups.push(
        world
          .incoming(node.id)
          .filter(({ held }) => read.holds(held))
          .map(
            ({ edge }) =>
              `${to} <- ${edgeParityLine(this.parityIdentity(edge.owner, read), { ...edge.edge, path: this.relativePathBy(edge.owner, edge.keys, read) }, to)}`,
          ),
      );
    }
    return groups.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")).flat();
  }

  /** Whether `element` is in the graph at `witness`. */
  holdsAt(element: HeldAt, witness: World): boolean {
    return element.holdings.every((h) => takenAt(this.union.space, h.condition, h.path, witness.assignment, witness.forcing));
  }

  /** What `edge` reaches, each outcome with where it holds, the edge's own
   *  condition included. */
  targets(edge: HeldGraphEdge): HeldTarget<Condition>[] {
    const { space } = this.union;
    return this.outcomes(edge)
      .map(({ to, scoped, condition }) => ({ to, scoped, held: space.and(edge.condition, condition) }))
      .filter((t) => t.held !== FALSE);
  }

  /** What `edge` reaches at `witness`, where it holds there. */
  targetAt(edge: HeldGraphEdge, witness: World): HeldTarget<boolean> | undefined {
    if (!this.holdsAt(edge, witness)) return undefined;
    const request = edge.target;
    if (request.form === "none") return { to: undefined, scoped: false, held: true };
    if (request.form === "extracted") return { to: request.id, scoped: false, held: true };
    if (request.form === "coReferrer") {
      const reaches = (held: HeldGraphEdge) => this.targetAt(held, witness)?.to === request.target;
      return reaches(request.via) && reaches(request.referrer) ? { to: request.id, scoped: false, held: true } : undefined;
    }
    if (request.form === "name") {
      const found = this.names.locateAt(request.population, request.name, request.module, request.within, witness);
      if (!this.ownInstanceRead(request, found)) return { ...reachedBy(found), held: true };
      const instance = this.names.inModuleAt(request.population, request.name, request.module, request.importPath, witness);
      return { ...reachedBy(instance.outcome.status === "resolved" ? instance : found), held: true };
    }
    if (request.form === "alias") {
      const several = this.names.severalInAt("declaredNodes", request.name, request.module, witness);
      const outcome = this.names.inModuleAt(
        "declaredNodes",
        request.name,
        request.module,
        several ? request.importPath : undefined,
        witness,
      );
      return { ...reachedBy(outcome), held: true };
    }
    const outcome = this.names.inModuleAt("declaredNodes", request.name, request.module, undefined, witness);
    return { ...reachedBy(outcome), held: true };
  }

  /** Whether a bare name found module-level in its own module is read again
   *  in the writer's own instance, as a run's graph reads one written in a
   *  copy of a library imported several times — falling back to what was
   *  found where that instance declares none. */
  private ownInstanceRead(
    request: Extract<TargetRequest, { form: "name" }>,
    found: ConditionedOutcome,
  ): request is typeof request & { importPath: readonly string[] } {
    const resolved = found.outcome;
    return (
      request.importPath !== undefined &&
      resolved.status === "resolved" &&
      !resolved.address.scope &&
      (resolved.declaration.metadata as { module?: string } | undefined)?.module === request.module
    );
  }

  private outcomes(edge: HeldGraphEdge): { to: string | undefined; scoped: boolean; condition: Condition }[] {
    const request = edge.target;
    if (request.form === "none") return [{ to: undefined, scoped: false, condition: TRUE }];
    if (request.form === "extracted") return [{ to: request.id, scoped: false, condition: TRUE }];
    if (request.form === "coReferrer") {
      const { space } = this.union;
      const reaching = (held: HeldGraphEdge, own: boolean): Condition => {
        let condition = FALSE as Condition;
        for (const outcome of this.outcomes(held)) {
          if (outcome.to === request.target) condition = space.or(condition, outcome.condition);
        }
        return own ? condition : space.and(held.condition, condition);
      };
      const condition = space.and(reaching(request.via, true), reaching(request.referrer, false));
      return condition === FALSE ? [] : [{ to: request.id, scoped: false, condition }];
    }
    if (request.form === "name") {
      const { space } = this.union;
      return this.names.locate(request.population, request.name, request.module, request.within).flatMap((found) => {
        if (!this.ownInstanceRead(request, found)) return [{ ...reachedBy(found), condition: found.condition }];
        return this.names
          .inModule(request.population, request.name, request.module, request.importPath)
          .map((instance) => ({
            ...reachedBy(instance.outcome.status === "resolved" ? instance : found),
            condition: space.and(found.condition, instance.condition),
          }))
          .filter((t) => t.condition !== FALSE);
      });
    }
    if (request.form === "alias") {
      // The alias names the module: its one declaration of the name, or the
      // importing instance's where it declares several.
      const { space } = this.union;
      const several = this.names.severalIn("declaredNodes", request.name, request.module);
      return [
        ...this.names
          .inModule("declaredNodes", request.name, request.module, request.importPath)
          .map((o) => ({ ...reachedBy(o), condition: space.and(o.condition, several) })),
        ...this.names
          .inModule("declaredNodes", request.name, request.module)
          .map((o) => ({ ...reachedBy(o), condition: space.and(o.condition, space.not(several)) })),
      ].filter((t) => t.condition !== FALSE);
    }
    return this.names
      .inModule("declaredNodes", request.name, request.module)
      .map((outcome) => ({ ...reachedBy(outcome), condition: outcome.condition }));
  }
}

/** The node an outcome names, and whether it is a scope member. */
export function reachedBy(outcome: ConditionedOutcome): { to: string | undefined; scoped: boolean } {
  const resolved = outcome.outcome;
  if (resolved.status !== "resolved") return { to: undefined, scoped: false };
  const declaration = resolved.declaration as ResourceManifest;
  const scope = resolved.address.scope;
  if (scope) {
    return { to: scopedMemberId(scope, declaration.kind as string, declaration.metadata?.name as string), scoped: true };
  }
  return { to: nodeIdFor(declaration), scoped: false };
}

export function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** The documents a module call's receivers are read off: each module
 *  document's identity and imports, and each import's alias. */
function namingDocuments(union: ConditionedExpansion): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  for (const { manifest: m } of union.declarations) {
    if (isModuleKind(m.kind as string)) {
      out.push({ kind: m.kind, metadata: m.metadata, ...(m as { imports?: unknown }).imports !== undefined ? { imports: (m as { imports?: unknown }).imports } : {} } as ResourceManifest);
    } else if (m.kind === "Telo.Import") {
      out.push({ kind: m.kind, metadata: m.metadata } as ResourceManifest);
    }
  }
  return out;
}

/**
 * The call graph of every configuration of `union`: its declarations and its
 * forward views, each read per chain of its options.
 */
export function conditionedCallGraph(inputs: ConditionedCallGraphInputs): ConditionedCallGraph {
  const { union, names, defs, aliases, aliasesByModule, scopeFieldsOf, withShapes, varying } = inputs;
  const { space } = union;
  const naming = namingDocuments(union);
  const nodes: HeldGraphNode[] = [];
  const edges: HeldGraphEdge[] = [];
  const views: HeldView[] = [];
  /** Per owner, the order each view's graph adds the owner's edges in. */
  const sequences = new Map<string, string[][]>();
  /** Where a reference site's slot stands among its kind's, the order the
   *  reach enumerates sites in. */
  const patternRanks = new Map<object, Map<string, number>>();
  const patternRank = (manifest: ResourceManifest, edge: CallGraphEdge): number => {
    if (!edge.slotKeys || edge.moduleCall) return 0;
    const declared = defs.declaredReachOf(manifest as { kind: string; metadata?: { module?: unknown } }, aliases, aliasesByModule);
    if (!declared) return 0;
    let ranks = patternRanks.get(declared);
    if (!ranks) {
      ranks = new Map(declared.references.map((reference, i) => [patternKey(reference.fieldKeys), i] as const));
      patternRanks.set(declared, ranks);
    }
    return ranks.get(patternKey(edge.slotKeys)) ?? ranks.size;
  };
  const declarations = [...union.declarations, ...union.views] as ConditionedDeclaration[];
  for (const declaration of declarations) {
    const root = declaration.manifest;
    if (!root.metadata?.name || !root.kind) continue;
    // An import is no node, and what it supplies is read off its views.
    if (root.kind !== "Telo.Import" && isKindDocumentOrImport(root)) continue;
    readDeclaration(declaration);
  }
  const scope = { defs, aliases, aliasesByModule, ...(varying ? { varying } : {}) };
  const ranked = ordered(edges, sequences);
  const read = new ConditionedCallGraph(union, names, scope, nodes, ranked, views);
  const coReferrers = coReferrerEdges(read, union, scope, inputs.libraries);
  if (coReferrers.length === 0 && inputs.parity === undefined) return read;
  return new ConditionedCallGraph(union, names, scope, nodes, [...ranked, ...coReferrers], views, inputs.parity);

  function readDeclaration(declaration: ConditionedDeclaration): void {
    const root = declaration.manifest;
    const rootId = nodeIdFor(root);
    const base: Holding = { condition: declaration.condition, path: declaration.path };
    const chains = chainsOf(root, space, base);
    // A choice written at a scope field: what its members are is read beside
    // every chain outside it.
    const scopeChoices: Alternatives[] = [];
    for (const field of scopeFieldsOf(root)) {
      const value = (root as Record<string, unknown>)[field];
      if (isAlternatives(value)) scopeChoices.push(value);
    }
    for (const chain of chains) {
      const through = new Set(chain.taken.map((t) => t.alternatives));
      let contexts: { taken: Taken[]; holdings: Holding[]; condition: Condition }[] = [{ taken: [], holdings: [], condition: TRUE }];
      for (const choice of scopeChoices) {
        if (through.has(choice)) continue;
        contexts = contexts.flatMap((context) =>
          choice.options.map((option, index) => ({
            taken: [...context.taken, { alternatives: choice, option: index }],
            holdings: [...context.holdings, holdingOf(option)],
            condition: space.and(context.condition, option.condition),
          })),
        );
      }
      contexts.forEach((context, i) => readView(declaration, rootId, chain, context, chain.taken.length === 0 && i === 0));
    }
  }

  function readView(
    declaration: ConditionedDeclaration,
    rootId: string,
    chain: Chain,
    context: { taken: Taken[]; holdings: Holding[]; condition: Condition },
    /** The view the declaration's own node is read off. */
    first: boolean,
    /** For a view read for the edges a case map's selector decides: the
     *  choice at the selector, whose option it takes — only those edges are
     *  read off it. */
    selector?: Alternatives,
  ): void {
    const root = declaration.manifest;
    // Everything a declaration holds is written in its module.
    const module = (root.metadata as { module?: string } | undefined)?.module;
    const taken = new Map<Alternatives, number>();
    for (const t of [...chain.taken, ...context.taken]) taken.set(t.alternatives, t.option);
    const chainChoices = chain.taken.map((t) => t.alternatives);
    const holdings = [...chain.holdings, ...context.holdings];
    const condition = space.and(chain.condition, context.condition);
    reportKeyCost({ kind: "graph-reading", declaration });
    const view = viewOf(root, taken) as ResourceManifest;
    const home = (keys: Keys): boolean => {
      const on = choicesOnTheWay(root, keys, taken);
      return !!on && on.length === chainChoices.length && on.every((choice, i) => choice === chainChoices[i]);
    };
    const orderOf = (keys: Keys) => documentOrder(root, keys, taken);
    if (root.kind === "Telo.Import") {
      views.push({ declaration, manifests: [{ manifest: view, id: rootId, keys: [] }], home, orderOf, condition, holdings });
      return;
    }
    /** The choices on the way to a case map's selector of the edge at `keys`,
     *  and the first the view takes no option of. */
    const selectorWay = (keys: Keys, pointer: string): { through: Alternatives[]; untaken?: Alternatives } => {
      const through: Alternatives[] = [];
      const last = keys[keys.length - 1];
      if (typeof last !== "string" || !pointer.startsWith("/")) return { through };
      const segments = pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
      let node: unknown = root;
      for (const key of [...keys.slice(0, -1), ...segments, undefined]) {
        while (isAlternatives(node)) {
          const index = taken.get(node);
          if (index === undefined) return { through, untaken: node };
          through.push(node);
          node = node.options[index]!.present ? node.options[index]!.value : undefined;
        }
        if (key === undefined || node === null || typeof node !== "object") break;
        node = (node as Record<string | number, unknown>)[Array.isArray(node) ? Number(key) : key];
      }
      return { through };
    };
    /** A choice at a selector some edge's use is decided by, read once per
     *  option beside this view. */
    const split = new Set<Alternatives>();
    // A reference site varying named shapes read differently is a cut point:
    // the view is read once with every cut point on its first side, then once
    // per other side of each — the cut points enclosing it on the sides that
    // reach it, every other one on its first — each place holding on its side.
    const readings: SlotReading[] = [{ chain: [] }];
    const known = new Set<string>(["[]"]);
    for (let r = 0; r < readings.length; r++) readSide(readings[r]!, r === 0);
    function readSide(reading: SlotReading, firstReading: boolean): void {
    reportKeyCost({ kind: "graph-side", declaration });
    const met = new Map<string, MetSlot>();
    const read = () => {
      const normalized = normalizeInlineResources([view], defs, aliases, aliasesByModule);
      const graph = buildCallGraph([...normalized, ...naming.filter((doc) => doc.metadata !== root.metadata)], defs, {
        aliases,
        aliasesByModule,
        coReferrers: false,
      });
      return { normalized, graph };
    };
    const { normalized, graph } = withShapes(() =>
      varying ? defs.withDecidedReach(varying, slotDecision(reading, met, space, view), read) : read(),
    );
    // Each slot this side met beneath the cut point it reads another side of
    // has sides of its own; one outside it is read off the reading enclosing
    // it, whose places this one does not hold.
    const enclosing = reading.chain[reading.chain.length - 1]?.slot;
    for (const slot of met.values()) {
      if (reading.chain.some((each) => each.slot.id === slot.id)) continue;
      if (enclosing && !isAtOrAbove(enclosing.keys, slot.keys)) continue;
      for (let side = 1; side < slot.sides.length; side++) {
        const chain = [...reading.chain, { slot, side }];
        const id = JSON.stringify(chain.map((each) => [each.slot.id, each.side]));
        if (known.has(id)) continue;
        known.add(id);
        readings.push({ chain });
      }
    }
    const inner = reading.chain[reading.chain.length - 1]?.slot;
    /** Where the place at `keys` holds on this side: inside the innermost
     *  cut point it takes another side of, each cut point on its way on the
     *  side this reading takes. */
    const sideOf = (keys: Keys): Condition | undefined => {
      if (inner && !isAtOrAbove(inner.keys, keys)) return undefined;
      let held = TRUE;
      const sideAt = (slot: MetSlot) => slot.sides[reading.chain.find((each) => each.slot.id === slot.id)?.side ?? 0]!.condition;
      for (const slot of met.values()) if (isAtOrAbove(slot.keys, keys)) held = space.and(held, sideAt(slot));
      for (const { slot } of reading.chain) if (!met.has(slot.id) && isAtOrAbove(slot.keys, keys)) held = space.and(held, sideAt(slot));
      return held;
    };
    const homeHere = (keys: Keys): boolean => home(keys) && sideOf(keys) !== undefined && sideOf(keys) !== FALSE;
    const heldHere = (keys: Keys): { condition: Condition; holdings: Holding[] } => {
      const side = sideOf(keys) ?? TRUE;
      return side === TRUE
        ? { condition, holdings: [...holdings] }
        : { condition: space.and(condition, side), holdings: [...holdings, { condition: side, path: [] }] };
    };
    // Where each manifest of the view is written in the declaration.
    const viewRoot = normalized[0]!;
    const keysOf = new Map<ResourceManifest, Keys>([[viewRoot, []]]);
    const byName = new Map<string, ResourceManifest>();
    for (const m of normalized) if (typeof m.metadata?.name === "string") byName.set(m.metadata.name, m);
    const placeOf = (m: ResourceManifest): Keys | undefined => {
      const known = keysOf.get(m);
      if (known) return known;
      const origin = readOrigin(m);
      if (!origin) return undefined;
      const parent = byName.get(origin.parentName);
      const at = parent && parent !== m ? placeOf(parent) : undefined;
      if (!at) return undefined;
      const keys = [...at, ...(origin.keysFromParent ?? parseKeys(origin.pathFromParent))];
      keysOf.set(m, keys);
      return keys;
    };
    const depthOf = (m: ResourceManifest): number => {
      const origin = readOrigin(m);
      const parent = origin ? byName.get(origin.parentName) : undefined;
      return parent && parent !== m ? 1 + depthOf(parent) : 0;
    };
    // Where each object of a view manifest stands, for a scope member.
    const objectKeys = new Map<object, Keys>();
    const indexObjects = (value: unknown, keys: Keys): void => {
      if (value === null || typeof value !== "object" || isRefSentinel(value) || isTaggedSentinel(value) || isCompiledValue(value)) return;
      if (objectKeys.has(value)) return;
      objectKeys.set(value, keys);
      if (Array.isArray(value)) value.forEach((item, i) => indexObjects(item, [...keys, i]));
      else for (const [key, member] of Object.entries(value)) indexObjects(member, [...keys, key]);
    };
    for (const m of normalized) {
      const at = placeOf(m);
      if (at) indexObjects(m, at);
    }
    // The view's nodes, by the view's ids.
    const unionIdOf = new Map<string, { id: string; keys: Keys; manifest: ResourceManifest }>();
    for (const node of graph.nodes.values()) {
      if (node.type !== "resource") continue;
      const manifest = node.manifest;
      if (node.scoped) continue;
      if (manifest === viewRoot) {
        unionIdOf.set(node.id, { id: rootId, keys: [], manifest });
        const base = chain.holdings[0]!;
        if (first && firstReading && !selector) nodes.push({ id: rootId, node, declaration, keys: [], place: [], condition: base.condition, holdings: [base], taken });
        continue;
      }
      if (!normalized.includes(manifest)) continue;
      const keys = placeOf(manifest);
      if (!keys) continue;
      const id = `${rootId}#inline#${JSON.stringify(keys)}`;
      unionIdOf.set(node.id, { id, keys, manifest });
      if (!selector && homeHere(keys)) {
        nodes.push({
          id,
          node,
          declaration,
          keys,
          place: orderOf(keys),
          taken,
          ...heldHere(keys),
          extracted: true,
          depth: depthOf(manifest),
        });
      }
    }
    if (!selector) views.push({
      declaration,
      manifests: normalized.flatMap((manifest) => {
        const keys = placeOf(manifest);
        return keys ? [{ manifest, id: keys.length === 0 ? rootId : `${rootId}#inline#${JSON.stringify(keys)}`, keys }] : [];
      }),
      home: homeHere,
      orderOf,
      ...(inner ? heldHere(inner.keys) : { condition, holdings }),
    });
    for (const node of graph.nodes.values()) {
      if (node.type !== "resource" || !node.scoped || !node.scopeOwner || !node.scopeSite) continue;
      if (selector) {
        // Read for its edges alone: what names the member is all it needs.
        const owner = graph.nodes.get(node.scopeOwner);
        const ownerUnion = owner?.type === "resource" ? unionIdOf.get(owner.id) : undefined;
        const holder = owner?.type === "resource" ? addressOf(owner.manifest) : undefined;
        const keys = objectKeys.get(node.manifest);
        if (holder && keys && ownerUnion) unionIdOf.set(node.id, { id: scopedMemberId({ holder, field: node.scopeSite }, node.kind, node.name), keys, manifest: node.manifest });
        continue;
      }
      const owner = graph.nodes.get(node.scopeOwner);
      const ownerUnion = owner?.type === "resource" ? (unionIdOf.get(owner.id) ?? undefined) : undefined;
      const holder = owner?.type === "resource" ? addressOf(owner.manifest) : undefined;
      const keys = objectKeys.get(node.manifest);
      if (!holder || !keys) continue;
      const site: ScopeSite = { holder, field: node.scopeSite };
      const id = scopedMemberId(site, node.kind, node.name);
      unionIdOf.set(node.id, { id, keys, manifest: node.manifest });
      if (homeHere(keys)) {
        nodes.push({
          id,
          node,
          declaration,
          keys,
          place: orderOf(keys),
          taken,
          ...heldHere(keys),
          ...(ownerUnion ? { owner: ownerUnion.id } : {}),
          site,
        });
      }
    }
    for (const node of selector ? [] : graph.nodes.values()) {
      if (node.type !== "step") continue;
      const owner = unionIdOf.get(node.owner);
      if (!owner) continue;
      const keys = [...owner.keys, ...parseKeys(node.path)];
      if (!homeHere(keys)) continue;
      nodes.push({
        id: `${owner.id}#${node.path}`,
        node,
        declaration,
        keys,
        place: orderOf(keys),
        taken,
        ...heldHere(keys),
        owner: owner.id,
      });
    }
    const ownerOf = (from: string): { id: string; keys: Keys; manifest: ResourceManifest } | undefined => {
      const node = graph.nodes.get(from);
      if (node?.type === "step") return unionIdOf.get(node.owner);
      return unionIdOf.get(from);
    };
    // The order this view's graph adds each owner's edges in, beside the
    // views of its other chains: one total order holding every view's.
    const seen = new Map<string, string[]>();
    graph.edges.forEach((edge) => {
      const owner = ownerOf(edge.from);
      if (!owner) return;
      const keys = [...owner.keys, ...parseKeys(edge.path)];
      const list = seen.get(owner.id) ?? [];
      list.push(edgeIdentity(edge, graph.nodes.get(edge.from)?.type === "step", keys));
      seen.set(owner.id, list);
    });
    for (const [owner, list] of seen) {
      const all = sequences.get(owner) ?? [];
      all.push(list);
      sequences.set(owner, all);
    }
    graph.edges.forEach((edge, position) => {
      const owner = ownerOf(edge.from);
      if (!owner) return;
      const keys = [...owner.keys, ...parseKeys(edge.path)];
      if (!homeHere(keys)) return;
      if (edge.useBy !== undefined) {
        const way = selectorWay(keys, edge.useBy);
        if (way.untaken) {
          split.add(way.untaken);
          return;
        }
        if (selector && !way.through.includes(selector)) return;
      } else if (selector) return;
      const fromNode = graph.nodes.get(edge.from);
      const from = fromNode?.type === "step" ? `${owner.id}#${fromNode.path}` : owner.id;
      const category = edge.moduleCall ? MODULE_CALLS : fromNode?.type === "step" ? STEP_EDGES : REFERENCE_EDGES;
      edges.push({
        edge,
        from,
        owner: owner.id,
        declaration,
        keys,
        ...heldHere(keys),
        target: targetRequest(edge, owner.manifest, module, isForwardedDeclaration(root), byName, unionIdOf, graph.nodes),
        rank: [category, patternRank(owner.manifest, edge), ...orderOf(keys), position],
        identity: edgeIdentity(edge, fromNode?.type === "step", keys),
      } as HeldGraphEdge);
    });
    }
    for (const choice of split) {
      choice.options.forEach((option, index) => {
        readView(
          declaration,
          rootId,
          chain,
          {
            taken: [...context.taken, { alternatives: choice, option: index }],
            holdings: [...context.holdings, holdingOf(option)],
            condition: space.and(context.condition, option.condition),
          },
          false,
          choice,
        );
      });
    }
  }

  function targetRequest(
    edge: CallGraphEdge,
    source: ResourceManifest,
    module: string | undefined,
    forwarded: boolean,
    byName: ReadonlyMap<string, ResourceManifest>,
    unionIdOf: ReadonlyMap<string, { id: string }>,
    viewNodes: ReadonlyMap<string, unknown>,
  ): TargetRequest {
    if (edge.moduleCall) {
      // A call through another module's name is resolved by no graph.
      return edge.toName.includes(".") ? { form: "none" } : { form: "call", name: edge.toName, module };
    }
    if (edge.coReferrer) return { form: "none" };
    // An inline declaration the view extracted is its holder's own.
    if (edge.to && viewNodes.has(edge.to) && unionIdOf.has(edge.to)) {
      const reached = byName.get(edge.toName);
      if (reached && readOrigin(reached)) return { form: "extracted", id: unionIdOf.get(edge.to)!.id };
    }
    const value = valueAt(source, parseKeys(edge.path));
    const sentinel = refSentinelTarget(value);
    const written = sentinel
      ? { alias: sentinel.alias, name: sentinel.name }
      : isResolvedReference(value)
        ? { alias: value.alias, name: value.name }
        : undefined;
    if (!written) return { form: "none" };
    if (written.alias !== undefined && written.alias !== "Self") {
      const target = moduleAliasScope(source.metadata, aliases, aliasesByModule)?.moduleForAlias(written.alias);
      if (target === undefined) return { form: "none" };
      return {
        form: "alias",
        alias: written.alias,
        name: written.name,
        module: target,
        importPath: importPathThrough(source, written.alias),
      };
    }
    const importPath = importPathOf(source);
    return {
      form: "name",
      population: forwarded ? "declaredNodes" : "localNodes",
      name: written.name,
      module,
      ...(edge.within ? { within: edge.within } : {}),
      ...(importPath ? { importPath } : {}),
    };
  }
}

/**
 * The edges every `callsCoReferrers` slot adds, over every configuration: from
 * the slot's holder to each module-scope declaration of the call's kind, in the
 * load order of the lifetime domain of what the slot names, whose edge at the
 * call's slot names that same declaration — wherever the slot and that edge
 * both name it.
 */
function coReferrerEdges(
  graph: ConditionedCallGraph,
  union: ConditionedExpansion,
  scope: Pick<ConditionedCallGraphInputs, "defs" | "aliases" | "aliasesByModule">,
  libraries: readonly ModuleDocuments[] | undefined,
): HeldGraphEdge[] {
  const calling = graph.edges.filter((edge) => edge.edge.callsCoReferrers);
  if (calling.length === 0) return [];
  const { defs, aliases, aliasesByModule } = scope;
  const resources = graph.resourceNodes();
  const nodes = new Map<string, ResourceGraphNode>();
  for (const held of resources) nodes.set(held.id, { ...(held.node as ResourceGraphNode), id: held.id });
  const domains = lifetimeDomains(
    union.declarations.map((d) => d.manifest),
    nodes,
    libraries,
  );
  const kinds = new Map<string, string | undefined>();
  const kindOf = (node: ResourceGraphNode): string | undefined => {
    if (!kinds.has(node.id)) {
      const kind = node.manifest.kind as string;
      const canonical = defs.resolve(kind)
        ? kind
        : moduleAliasScope(node.manifest.metadata, aliases, aliasesByModule)?.resolveKind(kind);
      const definition = canonical ? defs.resolve(canonical) : undefined;
      kinds.set(node.id, definition ? canonicalKindOf(definition) : undefined);
    }
    return kinds.get(node.id);
  };
  const out: HeldGraphEdge[] = [];
  for (const via of calling) {
    const call = via.edge.callsCoReferrers!;
    const path = pointerToPath(call.slot);
    for (const target of new Set(graph.targets(via).map((t) => t.to))) {
      if (target === undefined) continue;
      const root = domains.roots.get(domains.domainOf(target)?.key ?? APP_DOMAIN);
      if (!root) continue;
      let index = 0;
      for (const instance of instancesInLoadOrder(root)) {
        for (const declaration of instance.declarations) {
          const position = index++;
          if (declaration.id === via.from) continue;
          const kind = kindOf(declaration);
          if (kind === undefined || !kindIsA(kind, call.kind, (k) => defs.resolve(k))) continue;
          for (const referrer of graph.edgesFrom(declaration.id)) {
            const { edge } = referrer;
            if (edge.nested || edge.moduleCall || edge.coReferrer || edge.path !== path) continue;
            if (!graph.targets(referrer).some((t) => t.to === target)) continue;
            out.push({
              ...via,
              edge: {
                from: via.edge.from,
                toName: declaration.name,
                slot: via.edge.slot,
                ...(via.edge.slotKeys ? { slotKeys: via.edge.slotKeys } : {}),
                path: via.edge.path,
                use: ["call"],
                coReferrer: true,
              },
              target: { form: "coReferrer", via, referrer, target, id: declaration.id },
              rank: [Number.MAX_SAFE_INTEGER, ...via.rank, position],
              identity: `coReferrer:${via.identity}:${declaration.id}:${referrer.identity}`,
            });
          }
        }
      }
    }
  }
  return out;
}

/** An edge's identity in its owner's order: what kind of site it is and
 *  where. */
function edgeIdentity(edge: CallGraphEdge, fromStep: boolean, keys: Keys): string {
  const category = edge.moduleCall ? MODULE_CALLS : fromStep ? STEP_EDGES : REFERENCE_EDGES;
  return `${category}:${edge.slot}:${JSON.stringify(keys)}`;
}

/**
 * `edges` ranked, per owner, by one order holding every view's own: each
 * view's graph adds an owner's edges in a run's order, and two edges no view
 * holds together fall back on their kind of site, their slot's place in the
 * reach and where each is written.
 */
function ordered(edges: HeldGraphEdge[], sequences: ReadonlyMap<string, readonly string[][]>): HeldGraphEdge[] {
  const byOwner = new Map<string, HeldGraphEdge[]>();
  for (const edge of edges) {
    const list = byOwner.get(edge.owner) ?? [];
    list.push(edge);
    byOwner.set(edge.owner, list);
  }
  const out: HeldGraphEdge[] = [];
  for (const [owner, list] of byOwner) {
    const fallback = new Map<string, readonly number[]>();
    for (const edge of list) {
      const known = fallback.get(edge.identity);
      if (!known || compareRanks(edge.rank, known) < 0) fallback.set(edge.identity, edge.rank);
    }
    const before = new Map<string, Set<string>>();
    const after = new Map<string, Set<string>>();
    for (const id of fallback.keys()) {
      before.set(id, new Set());
      after.set(id, new Set());
    }
    for (const sequence of sequences.get(owner) ?? []) {
      const held = sequence.filter((id) => fallback.has(id));
      for (let i = 1; i < held.length; i++) {
        if (held[i - 1] === held[i]) continue;
        before.get(held[i])!.add(held[i - 1]!);
        after.get(held[i - 1])!.add(held[i]!);
      }
    }
    const position = new Map<string, number>();
    const ready = [...fallback.keys()].filter((id) => before.get(id)!.size === 0);
    const byFallback = (a: string, b: string) => compareRanks(fallback.get(a)!, fallback.get(b)!);
    while (position.size < fallback.size) {
      if (ready.length === 0) {
        // Views disagreeing is no order: what is left goes by its fallback.
        const rest = [...fallback.keys()].filter((id) => !position.has(id)).sort(byFallback);
        ready.push(rest[0]!);
      }
      ready.sort(byFallback);
      const next = ready.shift()!;
      if (position.has(next)) continue;
      position.set(next, position.size);
      for (const later of after.get(next)!) {
        const waiting = before.get(later)!;
        waiting.delete(next);
        if (waiting.size === 0 && !position.has(later)) ready.push(later);
      }
    }
    for (const edge of list) out.push({ ...edge, rank: [position.get(edge.identity)!, ...edge.rank] });
  }
  return out;
}

/** The value at `keys` of `root`, undefined where nothing is. */
function valueAt(root: unknown, keys: Keys): unknown {
  let node = root;
  for (const key of keys) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}
