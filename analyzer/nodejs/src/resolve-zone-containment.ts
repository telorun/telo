/**
 * Zone containment — *what is inside this zone*, which is the opposite question
 * from the one `resolve-zone-requirements.ts` answers.
 *
 * The landed projection propagates a requirement callee→caller and asks *is this
 * requirement satisfied*. Every check built on zone ATTRIBUTES asks the reverse:
 * a `noSuspend` region has to know what it contains before it can forbid parking
 * inside it, a `replayed` region before it can reject a detached dispatch, an
 * `idempotent` region before it can call impure CEL a broken promise. So this is
 * a DOWNWARD walk from a providing slot to everything its body reaches.
 *
 * It is a second consumer of the shared call graph, not a second graph, and it
 * is **parameterized over the attribute that opens the region** — so the durable
 * zone (`replayed`) and the constraint zones (`noSuspend`, `atomic`,
 * `idempotent`) share one traversal. It resolves an attribute NAME and nothing
 * else: no kind is named here, which is what keeps `modules/durable` out of the
 * analyzer's surface and satisfies the topology-driven constraint.
 *
 * **Two shapes of body slot, one region.** A slot may hold its body as a
 * reference to an executable (`Sql.Transaction.steps`) or carry a step array
 * natively (the shared `Step` fragment, which any kind may point at). Both are
 * regions; the first is entered through the slot's edge, the second through the
 * step nodes the slot declares. Handling only the first would have made the
 * checks silently vacuous on exactly the kinds written after the grammar became
 * shared vocabulary.
 *
 * **The walk under-approximates, and that is the safe direction — for a CHECK.**
 * A dynamically dispatched edge is invisible here, so a check over the result
 * may stay silent where it should have spoken, and the runtime enforcement is
 * what closes it. A consumer at the OPPOSITE polarity — the durable manifest
 * digest, whose blind spot is silent replay against changed code rather than a
 * missed diagnostic — must not inherit this tolerance, and verifies its coverage
 * against the journal instead of trusting this set.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { CallGraph, CallGraphEdge, CallGraphNode, ResourceGraphNode } from "./call-graph.js";
import { propertySchemas, resolveLocalRef } from "./manifest-navigation.js";
import { isStepSlot } from "./step-slot.js";
import { readProvidesZone } from "./zone-slot.js";

/** One node the region reaches, with the route taken to it. */
export interface ContainedNode {
  node: CallGraphNode;
  /** Labels of the hops from the body slot to this node, for a diagnostic that
   *  names the path rather than only the endpoint. */
  via: string[];
}

/** A dispatch that leaves the region without extending it.
 *
 *  Recorded rather than followed, because the two facts are different and both
 *  are wanted: the zone's lifetime does NOT reach the target (so nothing inside
 *  it is contained), while the dispatch itself is a site inside the region that
 *  a check may forbid outright — `DURABLE_DETACH_FORBIDDEN` is exactly that. */
export interface RegionBoundary {
  edge: CallGraphEdge;
  /** The resource whose slot dispatches this way. */
  from: ResourceGraphNode;
  via: string[];
  /** Why the zone stops here: the uses that do not extend it. */
  escaping: string[];
}

/** A region opened by one providing slot carrying the requested attribute. */
export interface ZoneRegion {
  /** The attribute that opened it — the one the walk was asked for. */
  attribute: string;
  /** The author's reason, quoted verbatim by every diagnostic over this region.
   *  Present by construction: an attribute's value IS the reason. */
  reason: string;
  /** The resource whose slot establishes the zone. */
  provider: ResourceGraphNode;
  /** Field-map path of the body slot (`steps`, `invoke`). */
  slot: string;
  /** Every attribute the slot declares, not only the requested one — a consumer
   *  deciding collapse reads `atomic` and `idempotent` off one region. */
  attributes: Readonly<Record<string, string>>;
  /** Everything control reaches from the body, keyed by node id. Includes the
   *  step nodes of a native body, since a step is where a check anchors. */
  contents: ReadonlyMap<string, ContainedNode>;
  /** Dispatches inside the region that the zone does not extend through. */
  boundaries: readonly RegionBoundary[];
}

/** Resolves a kind name to its definition in the scope of the module that
 *  DECLARED it — the same resolver the projection takes, passed in rather than
 *  rebuilt so both walks agree about what a kind means. */
export type DefinitionLookup = (kind: string, module?: string) => ResourceDefinition | undefined;

const moduleOf = (node: ResourceGraphNode): string | undefined =>
  (node.manifest.metadata as { module?: string } | undefined)?.module;

/** The schema node at a field-map path, following `[]` into `items`, `{}` into
 *  `additionalProperties` and local `$defs` refs. Same navigation the projection
 *  performs — a slot's annotations live wherever this lands. */
function schemaNodeAt(
  rootSchema: Record<string, any> | undefined,
  slotPath: string,
): Record<string, any> | undefined {
  if (!rootSchema) return undefined;
  let current: Record<string, any> | undefined = rootSchema;
  for (const segment of slotPath.split(".")) {
    if (!current) return undefined;
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

/**
 * Does a zone's lifetime extend through this edge?
 *
 * EVERY member of `use` must be `call`. This is the landed reduction, and its
 * asymmetry with the propagation rule is deliberate: a set says several
 * relations hold at once, so a slot declaring `[call, detached]` really does
 * detach on some dispatch, and a detached dispatch is never inside the caller's
 * zone. An edge whose `use` could not be read extends nothing either — the
 * conservative direction HERE, since over-reporting containment would invent
 * failures inside regions that are correct.
 */
function extendsZone(edge: CallGraphEdge): boolean {
  return edge.use.length > 0 && !edge.unresolved && edge.use.every((u) => u === "call");
}

/** Uses on an edge that leave the region, for the boundary record. */
function escapingUses(edge: CallGraphEdge): string[] {
  return edge.use.filter((u) => u !== "call" && u !== "dependency" && u !== "schema");
}

/** Walk down from one entry edge, collecting what the zone reaches. */
function collect(
  graph: CallGraph,
  entries: readonly { edge?: CallGraphEdge; node: CallGraphNode; via: string[] }[],
  contents: Map<string, ContainedNode>,
  boundaries: RegionBoundary[],
): void {
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (contents.has(current.node.id)) continue;
    contents.set(current.node.id, { node: current.node, via: current.via });

    // A resource's own step nodes are part of whatever region reaches the
    // resource: a step is where a check anchors (`the retry at
    // importAll/fetch`), and its outgoing edge is the dispatch a rule judges.
    const stepNodes =
      current.node.type === "resource" ? graph.steps(current.node.id) : [];
    for (const step of stepNodes) {
      if (contents.has(step.id)) continue;
      queue.push({
        node: step,
        via: [...current.via, step.name ? `step '${step.name}'` : step.path],
      });
    }

    const owner: ResourceGraphNode | undefined =
      current.node.type === "resource"
        ? current.node
        : (graph.nodes.get(current.node.owner) as ResourceGraphNode | undefined);

    for (const edge of graph.edgesFrom(current.node.id)) {
      if (edge.use.every((u) => u === "dependency" || u === "schema")) continue;
      const target = edge.to ? graph.nodes.get(edge.to) : undefined;
      if (!extendsZone(edge)) {
        if (owner && escapingUses(edge).length > 0) {
          boundaries.push({
            edge,
            from: owner,
            via: current.via,
            escaping: escapingUses(edge),
          });
        }
        continue;
      }
      if (!target) continue;
      queue.push({
        node: target,
        via: [...current.via, `${edge.slot} → ${edge.toName}`],
      });
    }
  }
}

/**
 * Every region in the graph opened by a slot declaring `attribute`.
 *
 * The provider itself is NOT in `contents` — a zone constrains what runs inside
 * its body, not the resource that establishes it. A transaction's own
 * `connection:` dependency is outside the region it opens, and a rule that
 * treated the provider as contained would report the provider against its own
 * constraint.
 */
export function findZoneRegions(
  graph: CallGraph,
  resolveDef: DefinitionLookup,
  attribute: string,
): ZoneRegion[] {
  const regions: ZoneRegion[] = [];

  for (const node of graph.nodes.values()) {
    if (node.type !== "resource") continue;
    const def = resolveDef(node.kind, moduleOf(node));
    const rootSchema = def?.schema as Record<string, any> | undefined;
    if (!rootSchema) continue;

    // The providing slots of this kind, found by walking its own declared
    // properties rather than by knowing any kind's field names.
    for (const [slot, slotSchema] of providingSlots(rootSchema)) {
      const provides = readProvidesZone(slotSchema);
      const reason = provides?.attributes[attribute as keyof typeof provides.attributes];
      if (!provides || typeof reason !== "string") continue;

      const contents = new Map<string, ContainedNode>();
      const boundaries: RegionBoundary[] = [];

      // Shape one: the slot carries a step array natively. Its steps are the
      // body, and they are owned by this resource, so they are found by path
      // rather than by an edge.
      if (isStepSlot(slotSchema)) {
        const entries = graph
          .steps(node.id)
          .filter((step) => step.array === slot || step.array.startsWith(`${slot}[`))
          .map((step) => ({
            node: step as CallGraphNode,
            via: [step.name ? `step '${step.name}'` : step.path],
          }));
        collect(graph, entries, contents, boundaries);
      } else {
        // Shape two: the slot references an executable. Its edges are the body.
        // Entered regardless of the slot's OWN use — a providing slot
        // establishes its zone before the enclosing lifetime terminates on that
        // use, which is what lets a detached durable body both shed every
        // enclosing zone and open its own.
        const entries = graph
          .edgesFrom(node.id)
          .filter((edge) => edge.slot === slot && edge.to)
          .map((edge) => ({
            node: graph.nodes.get(edge.to!)!,
            via: [`${slot} → ${edge.toName}`],
          }))
          .filter((entry) => entry.node !== undefined);
        collect(graph, entries, contents, boundaries);
      }

      regions.push({
        attribute,
        reason,
        provider: node,
        slot,
        attributes: provides.attributes as Readonly<Record<string, string>>,
        contents,
        boundaries,
      });
    }
  }

  return regions;
}

/** Field-map paths of every slot in a kind's schema carrying a provides-zone
 *  annotation, with the schema node at each. Walks properties, array items and
 *  `additionalProperties`, resolving local `$ref`s — the paths the call graph's
 *  own edges are keyed by, so a slot found here matches an edge's `slot`. */
function providingSlots(
  rootSchema: Record<string, any>,
): Array<[slot: string, schema: Record<string, any>]> {
  const found: Array<[string, Record<string, any>]> = [];
  const seen = new Set<object>();

  const walk = (schema: Record<string, any> | undefined, path: string): void => {
    const node = resolveLocalRef(schema, rootSchema);
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (path && readProvidesZone(node)) found.push([path, node]);
    for (const [key, child] of propertySchemas(node)) {
      const childPath = path ? `${path}.${key}` : key;
      walk(child, childPath);
      // A slot's zone annotation may sit on the ARRAY (`steps`) or on its item
      // (`routes[].handler`); both are real field-map paths.
      const items = resolveLocalRef(child?.items as Record<string, any> | undefined, rootSchema);
      if (items) walk(items, `${childPath}[]`);
      const additional = resolveLocalRef(
        child?.additionalProperties as Record<string, any> | undefined,
        rootSchema,
      );
      if (additional) walk(additional, `${childPath}{}`);
    }
  };

  walk(rootSchema, "");
  return found;
}

/** Convenience for a consumer that only wants membership: every node id inside
 *  any region opened by `attribute`, mapped to the region that contains it. */
export function containmentIndex(
  regions: readonly ZoneRegion[],
): ReadonlyMap<string, ZoneRegion> {
  const index = new Map<string, ZoneRegion>();
  for (const region of regions) {
    for (const id of region.contents.keys()) {
      if (!index.has(id)) index.set(id, region);
    }
  }
  return index;
}

/** The manifests a region's contents belong to — what a diagnostic anchors on. */
export function regionManifests(region: ZoneRegion): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  for (const { node } of region.contents.values()) {
    if (node.type === "resource") out.push(node.manifest);
  }
  return out;
}
