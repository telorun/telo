/**
 * The placement of the union world: what a whole-application pass finds, in
 * the raw form a configuration's own finding takes — about a declaration of
 * the union at the path its projection gives the place, about a call-graph
 * node written inside one (a scope member, an extraction), or about a forward
 * view of the union — moved to where it is written. One placement is built
 * per analysis; each choice a move passes is decided by the reader the finding
 * is rendered with, so the place is read off the union keys alone and splits a
 * finding only where the way to it does.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { relocatePath } from "./choice-expansion.js";
import type { ConditionedCallGraph } from "./conditioned-call-graph.js";
import type { ChoiceDecider, ConditionedDeclaration, ConditionedExpansion, ConditionedView } from "./conditioned-expansion.js";
import { declarationKeyOf, Placement, type CarriedCover, type OriginIndex, type ScopeMemberIndex, type ViewPlacing, type WrittenInside } from "./placement.js";
import { forwardPointOf, type ForwardedEntry } from "./template-forward.js";
import { parseKeys } from "./template-expansion.js";
import { FALSE, type Condition, type ConditionSpace } from "./presence-condition.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { PassTable } from "./union-passes.js";
import type { FormPlace } from "./validate-reference-forms.js";
import { deadBranchReader, splitByReads, type DeadBranchRun, type WorldReader } from "./world-reader.js";

/** What the union world places by: built once per analysis. */
export interface UnionWorld {
  readonly union: ConditionedExpansion;
  /** How a finding stands for the form refusals among the union's declarations. */
  readonly forms?: (d: AnalysisDiagnostic) => FormPlace;
  /** The refusals a finding is, which cover what they hold where they hold. */
  readonly refusals?: (d: AnalysisDiagnostic) => readonly CarriedCover[] | undefined;
  /** The union's declarations by the identity a run's projection reports them
   *  under, in union order. */
  readonly byIdentity: ReadonlyMap<string, readonly ConditionedDeclaration[]>;
  /** The declarations whose identity a choice decides. */
  readonly chosenIdentity: readonly ConditionedDeclaration[];
  readonly viewsByName: ReadonlyMap<string, ConditionedView>;
  readonly placement: Placement;
}

const identityKey = (kind: unknown, name: unknown, source: unknown): string => JSON.stringify([kind, name, source]);

/** The union world of `union`: a finding about a node of `graph` names it by
 *  its id (`aboutDeclaration`). */
export function unionWorld(
  union: ConditionedExpansion,
  graph: ConditionedCallGraph,
  forms?: (d: AnalysisDiagnostic) => FormPlace,
  refusals?: (d: AnalysisDiagnostic) => readonly CarriedCover[] | undefined,
): UnionWorld {
  const byIdentity = new Map<string, ConditionedDeclaration[]>();
  const chosenIdentity: ConditionedDeclaration[] = [];
  for (const declaration of union.declarations) {
    const m = declaration.manifest;
    const meta = m.metadata as { name?: unknown; source?: unknown } | undefined;
    if (typeof m.kind !== "string" || (meta?.name !== undefined && typeof meta.name !== "string")) {
      chosenIdentity.push(declaration);
      continue;
    }
    const key = identityKey(m.kind, meta?.name, meta?.source);
    const list = byIdentity.get(key);
    if (list) list.push(declaration);
    else byIdentity.set(key, [declaration]);
  }
  const viewsByName = new Map<string, ConditionedView>();
  for (const view of union.views) viewsByName.set(view.manifest.metadata!.name as string, view);
  const shape = { union, ...(forms ? { forms } : {}), ...(refusals ? { refusals } : {}), byIdentity, chosenIdentity, viewsByName };
  return { ...shape, placement: unionPlacement(shape, graph) };
}

/** The union world's placement: each finding placed where the reader it is
 *  placed with decides each choice. */
function unionPlacement(world: Omit<UnionWorld, "placement">, graph: ConditionedCallGraph): Placement {
  const { union } = world;
  /** Where a finding about a node written inside a declaration of the union
   *  stands in it — of an extraction, or else of a scope member. */
  const writtenInside = (d: AnalysisDiagnostic, read: ChoiceDecider | undefined, extracted: boolean): WrittenInside | undefined => {
    const id = declarationKeyOf(d);
    const held = id === undefined ? undefined : graph.node(id);
    if (!held || held.keys.length === 0 || !!held.extracted !== extracted) return undefined;
    if (!read) throw new Error(`internal: a finding about the node '${id}' is placed in the union world with no reader.`);
    const path = (d.data as { path?: unknown } | undefined)?.path;
    return graph.reportedBy(id!, typeof path === "string" ? path : "", read);
  };
  const scopeMembers: ScopeMemberIndex = { memberPlace: (d, read) => writtenInside(d, read, false) };
  const origins: OriginIndex = {
    extractionPlace: (d, read) => {
      const at = writtenInside(d, read, true);
      return at && { ...at, rerouted: true };
    },
  };
  /** The declaration a raw finding is about, as a run's projection names it:
   *  the last present one of that identity. */
  const declarationOf = (d: AnalysisDiagnostic, read: ChoiceDecider): ConditionedDeclaration | undefined => {
    const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown } | undefined;
    if (!data?.resource) return undefined;
    const key = identityKey(data.resource.kind, data.resource.name, data.filePath);
    let found: ConditionedDeclaration | undefined;
    for (const declaration of world.byIdentity.get(key) ?? []) if (read.taken(declaration)) found = declaration;
    for (const declaration of world.chosenIdentity) {
      if (!read.taken(declaration)) continue;
      const projected = union.projectBy({ kind: declaration.manifest.kind, metadata: declaration.manifest.metadata }, read).value as
        | { kind?: unknown; metadata?: { name?: unknown; source?: unknown } }
        | undefined;
      if (identityKey(projected?.kind, projected?.metadata?.name, projected?.metadata?.source) === key) found = declaration;
    }
    return found;
  };
  const relocate = (found: AnalysisDiagnostic[], read: ChoiceDecider | undefined): AnalysisDiagnostic[] =>
    found.map((d) => {
      if (!read) throw new Error("internal: a finding is placed in the union world with no reader.");
      const declaration = declarationOf(d, read);
      if (!declaration) return d;
      const data = d.data as { path?: unknown };
      const path = typeof data.path === "string" ? data.path : undefined;
      const places = union.placesAlong(declaration.manifest, path === undefined ? [] : parseKeys(path), read);
      if (places.mappings.length === 0) return d;
      return {
        ...d,
        data: {
          ...(d.data as Record<string, unknown>),
          ...(places.resource ? { resource: places.resource } : {}),
          ...(path !== undefined ? { path: relocatePath(path, places.mappings) } : {}),
        },
      };
    });
  return new Placement({
    scopeMembers,
    origins,
    ...(world.forms ? { forms: world.forms } : {}),
    ...(world.refusals ? { refusals: world.refusals } : {}),
    expansion: relocate,
    ...(world.viewsByName.size > 0 ? { writtenViews: unionViews(world) } : {}),
  });
}

/** The forward views of the union: a finding about one is placed by the place
 *  map of its way where the reader decides each choice, at its consumer. */
function unionViews(world: Omit<UnionWorld, "placement">): ViewPlacing {
  const { union } = world;
  return {
    holdsViews: true,
    analyzed: [],
    entryAbout(d: AnalysisDiagnostic, read?: ChoiceDecider): ForwardedEntry | undefined {
      const data = d.data as { resource?: { name?: unknown }; path?: unknown } | undefined;
      const name = data?.resource?.name;
      const view = typeof name === "string" ? world.viewsByName.get(name) : undefined;
      if (!view) return undefined;
      if (!read) throw new Error("internal: a finding is placed in the union world with no reader.");
      if (!read.taken(view)) return undefined;
      if (!view.body) throw new Error(`internal: the forward view of the body entry '${view.entryName}' holds nothing of its body.`);
      const path = typeof data?.path === "string" ? data.path : "";
      const places = union.placesAlong(view.manifest, parseKeys(path), read);
      const consumer = view.consumer.manifest;
      // A consumer written inside a declaration is reported where it is
      // written there: its places are that declaration's holder's.
      const within = view.consumer.declaredIn;
      const reportedAs = within
        ? (union.placeOf(within.manifest).resource ?? { kind: within.manifest.kind, name: within.manifest.metadata?.name as string })
        : union.placeOf(consumer).resource;
      const link = forwardPointOf(places, path);
      const consumerPlaces = union.placesToward(consumer, link?.to ?? [], read);
      const rootPlaces = within
        ? { ...consumerPlaces, mappings: [{ from: [], to: view.consumer.at }, ...consumerPlaces.mappings] }
        : consumerPlaces;
      return {
        view: view.manifest as ResourceManifest,
        entryKind: view.entryKind,
        entryName: view.entryName,
        upstream: consumer,
        links: [],
        root: consumer,
        places,
        rootPlaces,
        ...(reportedAs ? { reportedAs } : {}),
        body: view.body,
      };
    },
  };
}

/** A pass's finding placed where it is written: over the configurations where
 *  `condition` holds, or — `branch` — in that branch no configuration takes. */
export type PlacedPassFinding =
  | { readonly diagnostic: AnalysisDiagnostic; readonly condition: Condition }
  | { readonly diagnostic: AnalysisDiagnostic; readonly branch: DeadBranchRun };

let checkingPlaces = false;

/** Check, until the returned function is called, that each pass finding is
 *  placed alike at two configurations of the part it holds in. */
export function checkPassPlaces(): () => void {
  checkingPlaces = true;
  return () => {
    checkingPlaces = false;
  };
}

/** Every finding of `table`, placed in the union world: a finding over the
 *  configurations within `universe`, each part of it rendered once. */
export function placedPassFindings(table: PassTable, world: UnionWorld, universe: Condition): PlacedPassFinding[] {
  const { space } = world.union;
  const out: PlacedPassFinding[] = [];
  for (const finding of table.found) {
    const held = space.and(finding.held, universe);
    if (held === FALSE) continue;
    for (const part of splitByReads(space, held, (read) => world.placement.place([...finding.render(read)], read))) {
      if (checkingPlaces) checkPlaces(space, part, (read) => world.placement.place([...finding.render(read)], read));
      for (const diagnostic of part.value) out.push({ diagnostic, condition: part.condition });
    }
  }
  for (const finding of table.dead) {
    const read = deadBranchReader(space, finding.branch);
    for (const diagnostic of world.placement.place([...finding.render(read)], read)) out.push({ diagnostic, branch: finding.branch });
  }
  return out;
}

/** The written place of a finding. */
const placeOf = (d: AnalysisDiagnostic): string => {
  const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
  return JSON.stringify([data?.resource?.kind, data?.resource?.name, data?.filePath, data?.path]);
};

/** Throws unless `placed`, read at two configurations of its part, stands at
 *  the places the part's reading placed it. */
function checkPlaces(
  space: ConditionSpace,
  part: { readonly condition: Condition; readonly value: readonly AnalysisDiagnostic[] },
  placed: (read: WorldReader<Condition>) => readonly AnalysisDiagnostic[],
): void {
  const first = space.firstAssignment(part.condition)!;
  const other = space.firstAssignment(space.and(part.condition, space.not(space.assignment(first))));
  const expected = part.value.map(placeOf);
  for (const point of other ? [first, other] : [first]) {
    const holds = (condition: Condition) => space.holds(condition, point);
    const found = placed({ holds, taken: (element) => holds(element.condition) }).map(placeOf);
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      throw new Error(`internal: a pass finding is placed at ${found.join(", ")} in one configuration of its part and at ${expected.join(", ")} where the part was read.`);
    }
  }
}
