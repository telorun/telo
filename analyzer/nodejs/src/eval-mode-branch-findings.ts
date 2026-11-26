/**
 * `EVAL_MODE_BRANCH_CONFLICT` over every configuration at once: a union whose
 * branches give one property two eval meanings, judged once per position and
 * reported at the document declaring the union — a kind's own `schema:`, or
 * the named shape a kind's walk reaches.
 *
 * The eval-site walk (`eval-paths.ts`) is the one walk, read here with a
 * deferring lookup: at a reference to a named shape it records the reference
 * and does not enter the shape. Each node is walked once per reading of it —
 * a kind's schema, or one class of one shape — and beneath an eval site or
 * not, since a shape entered beneath one contributes no sites and has none of
 * its unions judged.
 *
 * Two branches compared at aligned positions are judged once per pair of the
 * positions they hold in their classes (`NamedShapeReader.pairVerdict`): a
 * reference at a side's own place is a reach edge to each class of the shape
 * it names, read as that class and labelled with where the edge holds, so a
 * side's sites hold under class ∧ reach and no comparison is made per
 * combination of classes. A site whose mode differs with nothing deferred
 * above it is a conflict of the pair itself, where the two sides differ; a
 * named shape beneath either side makes the comparison there a deferred pair.
 * Then, combining conditions alone:
 *
 *  1. where each pair is inconsistent — the least fixpoint, so recursive
 *     shapes agreeing at every depth stay consistent;
 *  2. where each union fails at each segment, from its branch pairs;
 *  3. where each union is reached from a kind's schema — the reach fixpoint
 *     over the references each walk stopped at.
 *
 * A finding holds under its writer's class, its reach and its union's failure
 * at the segment, split over the union's branch pairs: the first failing pair
 * in written order, where no earlier one fails. Its text is read from the
 * writer's own content alone, never from a shape: a conflict no named shape
 * lies above is the kernel's sentence, and one beneath a named shape spells
 * the place down to the references each side holds there, quoted as written.
 * The kernel reads the content walk alone, when it registers a kind
 * (`ERR_EVAL_MODE_BRANCH_CONFLICT`).
 *
 * A shape of a library imported more than once is read as the classes of
 * every instance (`NamedShapeReader.classes`), never one instance's: a kind
 * document is one document for every instance of its module, so what it finds
 * through a shape holds where some instance reads that class.
 *
 * Browser-safe.
 */
import { parseCanonicalTypeSchemaId, type ResourceManifest } from "@telorun/sdk";
import {
  declaredBranchSegments,
  deferredEvalWalk,
  firstSegment,
  type DeferredEvalWalk,
  type DeferredShapeRef,
  type EvalModeBranchConflict,
  type NamedShapeLookup,
} from "./eval-paths.js";
import {
  conflictLocation,
  EVAL_MODE_BRANCH_CONFLICT,
  evalModeBranchConflictMessage,
  evalModeBranchDeferredMessage,
  type DeferredBranchSide,
} from "./eval-mode-branch-conflict.js";
import { kindDeclarationOf } from "./kind-declaration.js";
import { kindDocumentProblemDiagnostic, quotingWrittenPlace } from "./kind-document-problem.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import type { ModuleDocuments } from "./module-documents.js";
import type { NamedShapeReader, ShapeClass } from "./named-shape-reader.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import type { ImportReach } from "./reaching-import.js";
import { renderValuePath } from "./text-slot.js";
import type { ReadFinding } from "./union-passes.js";
import type { WorldReader } from "./world-reader.js";

type Schema = Record<string, any>;

const isSchema = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** A node read with the document its own references resolve against. */
interface Component {
  readonly node: Schema;
  readonly document: Schema;
}

/** A node one side of a comparison holds, and where — relative to the
 *  comparison, whose own condition its edge carries. */
interface Member {
  readonly component: Component;
  readonly condition: Condition;
}

/** What one side of a comparison holds at the place it is compared at: the
 *  nodes written there, each a position in its document's class. */
type Side = readonly Member[];

/** One way a side's members hold together: the positions holding at once,
 *  and where. */
interface Cell {
  readonly components: readonly Component[];
  readonly condition: Condition;
}

/** What one side holds beneath the place it is compared at, over the nodes
 *  its references at that place reach, each entry where it holds. */
interface MergedWalk {
  readonly sites: ReadonlyMap<string, ReadonlyMap<string, Condition>>;
  readonly regions: ReadonlyMap<string, ReadonlyMap<string, Condition>>;
  readonly refs: ReadonlyMap<string, { readonly ref: DeferredShapeRef; readonly condition: Condition }>;
  readonly nodes: ReadonlyMap<string, ReadonlyMap<string, Member>>;
}

/** Which sites a comparison reads: every one, the compared value's own, or one
 *  property segment's. */
type Filter = "all" | "own" | `segment:${string}`;

/** A comparison's own judgement: where it conflicts of its own, and the
 *  deferred pairs it depends on, each where it is deferred. */
interface PairJudgement {
  readonly local: Condition;
  readonly subs: readonly { readonly condition: Condition; readonly key: string }[];
}

/** The document holding a kind's schema, or a named shape's class. */
export interface EvalModeKind {
  readonly manifest: ResourceManifest;
  readonly module: string | undefined;
  /** The schema of the kind it declares, canonical in its module. */
  readonly schema: Schema | undefined;
}

export interface EvalModeBranchScope {
  readonly shapes: NamedShapeReader;
  /** A kind's schema by its id. */
  readonly kindSchemaOf: (id: string) => Schema | undefined;
  readonly rootModules: ReadonlySet<string>;
  readonly reach: ImportReach;
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** A document as written, where the documents judged are copies. */
  readonly writtenOf?: (manifest: ResourceManifest) => ResourceManifest | undefined;
}

/** Where a union sits: a kind's schema, or one class of a named shape. */
type UnionDocument = { readonly kind: EvalModeKind } | { readonly shape: ShapeClass };

/** One union met beneath no eval site, in the document holding it. */
interface UnionAt {
  readonly union: Schema;
  readonly keyword: "oneOf" | "anyOf";
  readonly document: Schema;
  readonly holder: UnionDocument;
  /** Where it is reached from a kind's schema. */
  reach: Condition;
}

/** Where `inner` lies beneath the place `outer` (`""` beneath everything). */
function placeCovers(outer: string, inner: string): boolean {
  if (outer === "") return true;
  if (inner === outer) return true;
  return inner.startsWith(outer) && /[.[(]/.test(inner[outer.length] ?? "");
}

/** Where `target` sits in `root`, by identity, as a JSON Pointer. */
function pointerOf(root: unknown, target: object, seen = new Set<object>()): string | undefined {
  if (root === target) return "#";
  if (!root || typeof root !== "object" || seen.has(root)) return undefined;
  seen.add(root);
  const entries: [string, unknown][] = Array.isArray(root)
    ? root.map((value, i) => [String(i), value])
    : Object.entries(root as Schema);
  for (const [key, value] of entries) {
    const inner = pointerOf(value, target, seen);
    if (inner) return `#/${key.replace(/~/g, "~0").replace(/\//g, "~1")}${inner.slice(1)}`;
  }
  return undefined;
}

/** Every union conflict the kinds' schemas reach, each held where it holds. */
export function evalModeBranchFindings(kinds: readonly EvalModeKind[], scope: EvalModeBranchScope): ReadFinding[] {
  const { shapes } = scope;
  const { space } = shapes;
  const stops = (shape: string) => shapes.isShapeId(shape);
  const lookup: NamedShapeLookup = (id) => (shapes.isShapeId(id) ? undefined : scope.kindSchemaOf(id));

  const nodeIds = new WeakMap<object, number>();
  let nextNode = 0;
  const idOf = (node: object): number => {
    let id = nodeIds.get(node);
    if (id === undefined) nodeIds.set(node, (id = nextNode++));
    return id;
  };
  const classOf = new WeakMap<object, ShapeClass>();
  const kindWalks = new Map<string, DeferredEvalWalk>();

  /** A node's walk, once per reading of it and per eval-site flag. */
  const walkOf = (component: Component, underEval: boolean, kindRoot = false): DeferredEvalWalk => {
    const compute = () => deferredEvalWalk(component.node, component.document, stops, lookup, { kindRoot, underEval });
    const key = `${idOf(component.node)}:${underEval}:${kindRoot}`;
    const shape = classOf.get(component.document);
    if (shape) return shapes.verdict(`evalModeWalk:${key}`, shape, compute);
    let known = kindWalks.get(key);
    if (!known) kindWalks.set(key, (known = compute()));
    return known;
  };

  /** The nodes `target` names at `pointer`, one per class, each where its
   *  class holds beneath `condition`. */
  const targetsOf = (target: string, pointer: string, condition: Condition): Member[] => {
    const out: Member[] = [];
    for (const each of shapes.classes(target)) {
      classOf.set(each.schema, each);
      const node = resolveSchemaPointer(each.schema, pointer);
      const held = space.and(condition, each.condition);
      if (isSchema(node) && held !== FALSE) out.push({ component: { node, document: each.schema }, condition: held });
    }
    return out;
  };

  const componentKey = (component: Component): string => `${idOf(component.node)}/${idOf(component.document)}`;

  /** A side with every class a reference at its own place names read in as a
   *  reach edge — each class once, where the references reaching it hold. */
  const reachOf = (side: Side): Member[] => {
    const reached = new Map<string, Member>();
    const pending: Member[] = [];
    const add = (member: Member): void => {
      const key = componentKey(member.component);
      const known = reached.get(key);
      const condition = known ? space.or(known.condition, member.condition) : member.condition;
      if (known && condition === known.condition) return;
      const next = { component: member.component, condition };
      reached.set(key, next);
      pending.push(next);
    };
    side.forEach(add);
    while (pending.length > 0) {
      const member = pending.pop()!;
      if (reached.get(componentKey(member.component)) !== member) continue;
      for (const ref of walkOf(member.component, false).refs) {
        if (ref.path === "" && !ref.underEval) targetsOf(ref.target, ref.pointer, member.condition).forEach(add);
      }
    }
    return [...reached.values()];
  };

  const mergedWalks = new WeakMap<Side, MergedWalk>();
  const mergedOf = (side: Side): MergedWalk => {
    const memo = mergedWalks.get(side);
    if (memo) return memo;
    const sites = new Map<string, Map<string, Condition>>();
    const regions = new Map<string, Map<string, Condition>>();
    const refs = new Map<string, { ref: DeferredShapeRef; condition: Condition }>();
    const nodes = new Map<string, Map<string, Member>>();
    const into = (map: Map<string, Map<string, Condition>>, place: string, value: string, condition: Condition) => {
      const at = map.get(place) ?? new Map<string, Condition>();
      map.set(place, at);
      at.set(value, space.or(at.get(value) ?? FALSE, condition));
    };
    for (const { component, condition } of reachOf(side)) {
      const walked = walkOf(component, false);
      for (const [place, mode] of walked.sites) into(sites, place, mode, condition);
      for (const [place, region] of walked.regions) into(regions, place, region, condition);
      for (const ref of walked.refs) {
        const key = JSON.stringify([ref.path, ref.target, ref.pointer, ref.underEval]);
        const known = refs.get(key);
        refs.set(key, { ref: known?.ref ?? ref, condition: space.or(known?.condition ?? FALSE, condition) });
      }
      for (const found of walked.nodes) {
        const at = nodes.get(found.path) ?? new Map<string, Member>();
        nodes.set(found.path, at);
        const held = { node: found.node, document: found.document };
        const key = componentKey(held);
        at.set(key, { component: held, condition: space.or(at.get(key)?.condition ?? FALSE, condition) });
      }
    }
    const merged = { sites, regions, refs, nodes };
    mergedWalks.set(side, merged);
    return merged;
  };

  /** A side's members split by which of them hold together: one cell per
   *  set of positions holding at once — one per class of a shape the side
   *  names — so a comparison is judged once per pair of positions in their
   *  classes, never per combination of what lies beyond them. */
  const cellsOf = (side: Side): Cell[] => {
    const merged = new Map<string, Member>();
    for (const member of side) {
      if (member.condition === FALSE) continue;
      const key = componentKey(member.component);
      const known = merged.get(key);
      merged.set(key, { component: member.component, condition: space.or(known?.condition ?? FALSE, member.condition) });
    }
    const members = [...merged.values()];
    if (members.every((member) => member.condition === TRUE)) return [{ components: members.map((member) => member.component), condition: TRUE }];
    const out: Cell[] = [];
    let remaining = TRUE;
    while (remaining !== FALSE) {
      const at = space.firstAssignment(remaining)!;
      const components: Component[] = [];
      let condition = TRUE;
      for (const member of members) {
        const holds = space.holds(member.condition, at);
        if (holds) components.push(member.component);
        condition = space.and(condition, holds ? member.condition : space.not(member.condition));
      }
      out.push({ components, condition });
      remaining = space.and(remaining, space.not(condition));
    }
    return out;
  };

  // Stage 1's graph: every comparison judged once, by the positions it
  // compares in their classes, and the deferred comparisons it depends on.
  const judgements = new Map<string, PairJudgement>();
  const views = new Map<string, { a: Side; b: Side; filter: Filter }>();
  // One side per list of positions, so its merged walk is computed once
  // however many comparisons hold it.
  const sides = new Map<string, Side>();
  const keyOf = (a: readonly Component[], b: readonly Component[], filter: Filter): string => {
    const viewKey = (components: readonly Component[]) => [...new Set(components.map(componentKey))].sort().join(",");
    const [left, right] = [viewKey(a), viewKey(b)].sort();
    const key = `${left}|${right}|${filter}`;
    const held = (components: readonly Component[]): Side => {
      const listed = components.map(componentKey).join(",");
      let side = sides.get(listed);
      if (!side) sides.set(listed, (side = components.map((component) => ({ component, condition: TRUE }))));
      return side;
    };
    if (!views.has(key)) views.set(key, { a: held(a), b: held(b), filter });
    return key;
  };

  /** Where two sides' entries at one place differ: one holds the place where
   *  the other does not, or the two hold different values. */
  const differ = (mine: ReadonlyMap<string, Condition> | undefined, theirs: ReadonlyMap<string, Condition> | undefined): Condition => {
    const here = space.some(mine?.values() ?? []);
    const there = space.some(theirs?.values() ?? []);
    let out = space.or(space.and(here, space.not(there)), space.and(space.not(here), there));
    for (const [value, condition] of mine ?? []) {
      for (const [other, otherCondition] of theirs ?? []) if (value !== other) out = space.or(out, space.and(condition, otherCondition));
    }
    return out;
  };

  const judge = (key: string): PairJudgement => {
    const { a, b, filter } = views.get(key)!;
    return shapes.pairVerdict("evalModeBranch", key, () => {
      const left = mergedOf(a);
      const right = mergedOf(b);
      const inFilter = (place: string): boolean =>
        filter === "all" ? true : filter === "own" ? place === "" : firstSegment(place) === filter.slice("segment:".length);
      // Where a named shape defers each place beneath it.
      const deferring = new Map<string, Condition>();
      for (const walked of [left, right]) {
        for (const { ref, condition } of walked.refs.values()) {
          if (ref.underEval || ref.path === "" || filter === "own" || !inFilter(ref.path)) continue;
          deferring.set(ref.path, space.or(deferring.get(ref.path) ?? FALSE, condition));
        }
      }
      const deferredAt = (place: string, except?: string): Condition =>
        space.some([...deferring].filter(([at]) => at !== except && placeCovers(at, place)).map(([, condition]) => condition));
      let local: Condition = FALSE;
      for (const [mine, theirs] of [[left.sites, right.sites], [left.regions, right.regions]] as const) {
        for (const place of new Set([...mine.keys(), ...theirs.keys()])) {
          if (!inFilter(place)) continue;
          local = space.or(local, space.and(differ(mine.get(place), theirs.get(place)), space.not(deferredAt(place))));
        }
      }
      const subs: { condition: Condition; key: string }[] = [];
      for (const [place, condition] of deferring) {
        const top = space.and(condition, space.not(deferredAt(place, place)));
        if (top === FALSE) continue;
        const side = (walked: MergedWalk): Member[] => {
          const out = [...(walked.nodes.get(place)?.values() ?? [])];
          for (const { ref, condition: held } of walked.refs.values()) {
            if (!ref.underEval && ref.path === place) out.push(...targetsOf(ref.target, ref.pointer, held));
          }
          return out;
        };
        const others = cellsOf(side(right));
        for (const mine of cellsOf(side(left))) {
          for (const theirs of others) {
            const condition = space.and(top, space.and(mine.condition, theirs.condition));
            if (condition !== FALSE) subs.push({ condition, key: keyOf(mine.components, theirs.components, "all") });
          }
        }
      }
      return { local, subs };
    });
  };

  const graph = (roots: Iterable<string>): void => {
    const pending = [...roots];
    while (pending.length > 0) {
      const key = pending.pop()!;
      if (judgements.has(key)) continue;
      const judged = judge(key);
      judgements.set(key, judged);
      for (const sub of judged.subs) if (!judgements.has(sub.key)) pending.push(sub.key);
    }
  };

  // Stage 3's graph, built first: every union each kind's schema reaches, and
  // where it reaches it.
  const unions = new Map<object, UnionAt>();
  const meet = (walked: DeferredEvalWalk, holder: UnionDocument, reach: Condition): void => {
    for (const found of walked.unions) {
      const known = unions.get(found.union);
      if (known) known.reach = space.or(known.reach, reach);
      else unions.set(found.union, { union: found.union, keyword: found.keyword, document: found.document, holder, reach });
    }
  };
  const judgedKinds = new Set<string>();
  const roots: { node: { target: string; pointer: string; underEval: boolean }; condition: Condition }[] = [];
  for (const kind of kinds) {
    if (!kind.schema) continue;
    const key = `${kind.module ?? ""}\0${String(kind.manifest.metadata?.name)}`;
    if (judgedKinds.has(key)) continue;
    judgedKinds.add(key);
    const walked = walkOf({ node: kind.schema, document: kind.schema }, false, true);
    meet(walked, { kind }, TRUE);
    for (const ref of walked.refs) roots.push({ node: { target: ref.target, pointer: ref.pointer, underEval: ref.underEval }, condition: TRUE });
  }
  const positionWalk = (shape: ShapeClass, pointer: string, underEval: boolean): DeferredEvalWalk | undefined => {
    classOf.set(shape.schema, shape);
    const node = resolveSchemaPointer(shape.schema, pointer);
    return isSchema(node) ? walkOf({ node, document: shape.schema }, underEval) : undefined;
  };
  const reached = shapes.reachOver(
    roots,
    (position) =>
      shapes.classes(position.target).flatMap((shape) =>
        (positionWalk(shape, position.pointer, position.underEval)?.refs ?? []).map((ref) => ({
          node: { target: ref.target, pointer: ref.pointer, underEval: ref.underEval },
          condition: shape.condition,
        })),
      ),
    (position) => JSON.stringify([position.target, position.pointer, position.underEval]),
  );
  for (const { node: position, condition } of reached.values()) {
    for (const shape of shapes.classes(position.target)) {
      const held = space.and(condition, shape.condition);
      const walked = held === FALSE ? undefined : positionWalk(shape, position.pointer, position.underEval);
      if (walked) meet(walked, { shape }, held);
    }
  }

  // Stage 2's inputs: each union's branch pairs in written order, per segment
  // both declare, where both declare it.
  const segmentsOf = (components: readonly Component[]): Map<string, Condition> => {
    const out = new Map<string, Condition>();
    for (const { component, condition } of reachOf(components.map((each) => ({ component: each, condition: TRUE })))) {
      for (const segment of declaredBranchSegments(component.node, component.document, lookup, stops)) {
        out.set(segment, space.or(out.get(segment) ?? FALSE, condition));
      }
    }
    return out;
  };
  const verdictTerms = new Map<UnionAt, Map<string, BranchPair[]>>();
  for (const at of unions.values()) {
    const branches = (at.union[at.keyword] as unknown[]).map((branch): Component[] | undefined =>
      isSchema(branch) ? [{ node: branch, document: at.document }] : undefined,
    );
    const bySegment = new Map<string, BranchPair[]>();
    const segments = new Map<number, Map<string, Condition>>();
    const segmentsAt = (index: number, components: readonly Component[]) => {
      let known = segments.get(index);
      if (!known) segments.set(index, (known = segmentsOf(components)));
      return known;
    };
    const term = (segment: string, i: number, j: number, condition: Condition, key: string) => {
      const pairs = bySegment.get(segment) ?? [];
      if (pairs.length === 0) bySegment.set(segment, pairs);
      let pair = pairs.find((each) => each.i === i && each.j === j);
      if (!pair) pairs.push((pair = { i, j, terms: [] }));
      pair.terms.push({ condition, key });
    };
    for (let i = 0; i < branches.length; i++) {
      const mine = branches[i];
      if (!mine) continue;
      for (let j = i + 1; j < branches.length; j++) {
        const theirs = branches[j];
        if (!theirs) continue;
        term("", i, j, TRUE, keyOf(mine, theirs, "own"));
        const shared = segmentsAt(j, theirs);
        for (const [segment, condition] of segmentsAt(i, mine)) {
          const held = segment === "" ? FALSE : space.and(condition, shared.get(segment) ?? FALSE);
          if (held !== FALSE) term(segment, i, j, held, keyOf(mine, theirs, `segment:${segment}`));
        }
      }
    }
    for (const pairs of bySegment.values()) pairs.sort((a, b) => a.i - b.i || a.j - b.j);
    verdictTerms.set(at, bySegment);
    graph([...bySegment.values()].flatMap((pairs) => pairs.flatMap((pair) => pair.terms.map((each) => each.key))));
  }

  // Stage 1: where each comparison fails — the least fixpoint, so a cycle of
  // deferred pairs agreeing at every depth stays consistent.
  const failing = new Map<string, Condition>();
  const dependents = new Map<string, Set<string>>();
  for (const [key, judged] of judgements) {
    failing.set(key, judged.local);
    for (const sub of judged.subs) {
      const list = dependents.get(sub.key) ?? new Set<string>();
      list.add(key);
      dependents.set(sub.key, list);
    }
  }
  const queue = [...judgements.keys()];
  while (queue.length > 0) {
    const key = queue.pop()!;
    const judged = judgements.get(key)!;
    const before = failing.get(key)!;
    const after = space.or(judged.local, space.some(judged.subs.map((sub) => space.and(sub.condition, failing.get(sub.key) ?? FALSE))));
    if (after === before) continue;
    failing.set(key, after);
    for (const parent of dependents.get(key) ?? []) queue.push(parent);
  }

  /** How a failing branch pair reads in the writer's own content: a conflict
   *  no named shape lies above, or the first place a named shape defers. */
  const describe = (at: UnionAt, segment: string, i: number, j: number): PairReading | undefined => {
    const branchOf = (index: number) => (at.union[at.keyword] as unknown[])[index];
    const left = branchOf(i);
    const right = branchOf(j);
    if (!isSchema(left) || !isSchema(right)) return undefined;
    const mine = walkOf({ node: left, document: at.document }, false);
    const theirs = walkOf({ node: right, document: at.document }, false);
    const inFilter = (place: string): boolean => (segment === "" ? place === "" : firstSegment(place) === segment);
    const deferring = (walked: DeferredEvalWalk) =>
      walked.refs.filter((ref) => !ref.underEval && (ref.path === "" || (segment !== "" && inFilter(ref.path))));
    const places = [...new Set([...deferring(mine), ...deferring(theirs)].map((ref) => ref.path))];
    const deferred = (place: string) => places.some((at) => placeCovers(at, place));
    const differing = (a: DeferredEvalWalk, b: DeferredEvalWalk) =>
      [...a.sites].find(([place, mode]) => inFilter(place) && !deferred(place) && b.sites.get(place) !== mode)?.[0];
    const place = differing(mine, theirs) ?? differing(theirs, mine);
    const differingRegion = (a: DeferredEvalWalk, b: DeferredEvalWalk) =>
      [...a.regions].find(([at, region]) => inFilter(at) && !deferred(at) && b.regions.get(at) !== region)?.[0];
    const regionPlace = place === undefined ? (differingRegion(mine, theirs) ?? differingRegion(theirs, mine)) : undefined;
    if (regionPlace !== undefined) {
      const a = mine.regions.has(regionPlace);
      const b = theirs.regions.has(regionPlace);
      const [branch, other] = !a && b ? [j, i] : [i, j];
      const conflict: EvalModeBranchConflict = {
        path: "",
        union: at.union,
        document: at.document,
        keyword: at.keyword,
        branch,
        other,
        segment,
        place: regionPlace,
        mode: undefined,
        otherMode: undefined,
        regions: { branch: branch === i ? a : b, other: branch === i ? b : a },
      };
      return { local: conflict };
    }
    if (place !== undefined) {
      const a = mine.sites.get(place);
      const b = theirs.sites.get(place);
      const [branch, other] = a !== undefined && b === undefined ? [i, j] : [j, i];
      const conflict: EvalModeBranchConflict = {
        path: "",
        union: at.union,
        document: at.document,
        keyword: at.keyword,
        branch,
        other,
        segment,
        place,
        mode: branch === i ? a : b,
        otherMode: branch === i ? b : a,
      };
      return { local: conflict };
    }
    const top = places.find((place) => !places.some((at) => at !== place && placeCovers(at, place)));
    if (top === undefined) return undefined;
    const refAt = (walked: DeferredEvalWalk) => deferring(walked).find((ref) => ref.path === top)?.node;
    const sides: [DeferredSide, DeferredSide] = [
      { branch: i, node: refAt(mine) },
      { branch: j, node: refAt(theirs) },
    ];
    return { place: top, sides, anchor: sides[0].node || !sides[1].node ? i : j };
  };

  // Stage 2 and the findings: one per union and segment, split over its branch
  // pairs — the first failing in written order, where no earlier one fails —
  // at the document declaring the union.
  const out: ReadFinding[] = [];
  const byPlace = new Map<string, { held: Condition; at: UnionAt; segment: string; pointer: string; reading: PairReading }>();
  for (const [at, bySegment] of verdictTerms) {
    const pointer = pointerOf(at.document, at.union) ?? "#";
    const writer = "kind" in at.holder ? `kind\0${at.holder.kind.module ?? ""}\0${String(at.holder.kind.manifest.metadata?.name)}` : `shape\0${at.holder.shape.id}`;
    for (const [segment, pairs] of bySegment) {
      let earlier: Condition = FALSE;
      for (const pair of pairs) {
        const fails = space.some(pair.terms.map((each) => space.and(each.condition, failing.get(each.key) ?? FALSE)));
        const held = space.and(at.reach, space.and(fails, space.not(earlier)));
        earlier = space.or(earlier, fails);
        if (held === FALSE) continue;
        const reading = describe(at, segment, pair.i, pair.j);
        if (!reading) {
          throw new Error(
            `internal: the union at '${pointer}' of ${writer.split("\0").slice(1).join(".")} is judged to fail at '${segment}' between ${at.keyword}[${pair.i}] and ${at.keyword}[${pair.j}], where its own content finds neither a conflict nor a named shape.`,
          );
        }
        const key = JSON.stringify([writer, pointer, at.keyword, segment, readingKey(reading, at.document)]);
        const known = byPlace.get(key);
        if (known) known.held = space.or(known.held, held);
        else byPlace.set(key, { held, at, segment, pointer, reading });
      }
    }
  }
  for (const { held, at, segment, pointer, reading } of byPlace.values()) {
    out.push({ held, render: (read) => renderConflict(at, segment, pointer, reading, read, scope) });
  }
  return out;
}

/** One branch pair of a union at one segment, and the comparisons it fails by. */
interface BranchPair {
  readonly i: number;
  readonly j: number;
  readonly terms: { readonly condition: Condition; readonly key: string }[];
}

/** A side of a pair a named shape defers: its branch, and the node writing the
 *  reference it holds at the place compared, if any. */
interface DeferredSide {
  readonly branch: number;
  readonly node: Schema | undefined;
}

/** A failing pair as its writer's content reads it. */
type PairReading =
  | { readonly local: EvalModeBranchConflict }
  | { readonly place: string; readonly sides: readonly [DeferredSide, DeferredSide]; readonly anchor: number };

/** What tells two readings apart in one document. */
function readingKey(reading: PairReading, document: Schema): unknown {
  if ("local" in reading) {
    const { branch, other, place, mode, otherMode, regions } = reading.local;
    return ["local", branch, other, place, mode ?? null, otherMode ?? null, regions ?? null];
  }
  return ["deferred", reading.place, reading.anchor, reading.sides.map((side) => [side.branch, side.node ? pointerOf(document, side.node) ?? null : null])];
}

let renderObserver: (() => void) | undefined;

/** Observe every rendering of an eval-mode conflict until the returned function
 *  is called. */
export function observeEvalModeBranchRenders(listener: () => void): () => void {
  renderObserver = listener;
  return () => {
    if (renderObserver === listener) renderObserver = undefined;
  };
}

/** The finding at the document declaring the union, worded from that
 *  document's own content: `read` decides only which declaration writes it. */
function renderConflict(
  at: UnionAt,
  segment: string,
  pointer: string,
  reading: PairReading,
  read: WorldReader<Condition>,
  scope: EvalModeBranchScope,
) {
  renderObserver?.();
  const root = at.document;
  const writer = "kind" in at.holder ? at.holder.kind : shapeWriter(at.holder.shape.id, read, scope);
  if (!writer) return [];
  const name = `'${String(writer.manifest.metadata?.name)}'`;
  const unionPath = renderValuePath(["schema", ...valuePathOf(root, pointer)]);
  let path: string;
  let message: string;
  if ("local" in reading) {
    path = renderValuePath(["schema", ...conflictLocation(reading.local, root)]);
    message = evalModeBranchConflictMessage(reading.local, name, root);
  } else {
    const anchor = { ...reading.sides[0], branch: reading.anchor };
    const located: EvalModeBranchConflict = {
      path: "",
      union: at.union,
      document: root,
      keyword: at.keyword,
      branch: anchor.branch,
      other: anchor.branch,
      segment,
      place: reading.place,
      mode: undefined,
      otherMode: undefined,
    };
    path = renderValuePath(["schema", ...conflictLocation(located, root)]);
    const written = writtenSchemaOf(scope.writtenOf?.(writer.manifest) ?? writer.manifest);
    const side = ({ branch, node }: DeferredSide): DeferredBranchSide => ({ branch, ref: node ? writtenReference(root, written, node) : undefined });
    message = evalModeBranchDeferredMessage(name, unionPath, at.keyword, segment, reading.place, [side(reading.sides[0]), side(reading.sides[1])]);
  }
  const diagnostic = kindDocumentProblemDiagnostic(writer.manifest, writer.module, { code: EVAL_MODE_BRANCH_CONFLICT, path, message }, scope.reach);
  return [quotingWrittenPlace(diagnostic, path, unionPath)];
}

/** The schema a kind or shape document writes, as written. */
function writtenSchemaOf(manifest: ResourceManifest): unknown {
  const declared = kindDeclarationOf(manifest);
  return declared ? declared.schema : (manifest as Schema).schema;
}

/** A reference as its writer wrote it: the written node at the place `node`
 *  holds in `root`, the canonical one where the written document differs. */
function writtenReference(root: Schema, written: unknown, node: Schema): string {
  const pointer = pointerOf(root, node);
  const there = pointer === undefined || !isSchema(written) ? undefined : resolveSchemaPointer(written, pointer);
  return isSchema(there) && typeof there.$ref === "string" ? there.$ref : String(node.$ref);
}

/** The value path a JSON Pointer names in `root`, an array's index a number. */
function valuePathOf(root: unknown, pointer: string): (string | number)[] {
  const out: (string | number)[] = [];
  let node = root;
  for (const raw of pointer.replace(/^#\/?/, "").split("/")) {
    if (raw === "") continue;
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out.push(Array.isArray(node) ? Number(segment) : segment);
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined;
  }
  return out;
}

/** The declaration of a named shape present where `read` reads — the first in
 *  written order — or an imported library's document of it. */
function shapeWriter(id: string, read: WorldReader<Condition>, scope: EvalModeBranchScope) {
  for (const declaration of scope.shapes.declarationsOf(id)) {
    if (!read.holds(declaration.condition)) continue;
    const manifest = declaration.project(read);
    if (!manifest) continue;
    return { manifest, module: (manifest.metadata as { module?: string } | undefined)?.module };
  }
  const named = parseCanonicalTypeSchemaId(id);
  if (!named) return undefined;
  const library = scope.moduleDocuments.find((each) => each.module === named.moduleName);
  const manifest = library?.manifests.find((m) => m.metadata?.name === named.typeName && !!m.schema);
  return manifest ? { manifest, module: named.moduleName } : undefined;
}
