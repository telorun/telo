import type { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import {
  APPLICATION_KIND_ID,
  LIBRARY_KIND_ID,
  isModuleRootKind,
} from "../../../application-adapter";
import type { ModuleViewData } from "../../../model";
import {
  AMBIENT_CAPABILITIES,
  NODE_CAPABILITIES,
  buildOverviewGraph,
  refTargetName,
  type LabeledEdge,
  type UsesChip,
} from "./overview-graph";

/** A resource rendered as a graph node or a side-strip entry. */
export interface GraphNode {
  kind: string;
  name: string;
  capability: string;
  /** True for the synthetic module root node (Application or Library). */
  isRoot?: boolean;
}

/** Field label carried on the Application→target edges. */
export const TARGET_EDGE_LABEL = "target";

/** The full data model the Application overview canvas renders. Pure data —
 *  computed once from view data + the analysis registry, then handed to the
 *  renderer (which owns layout + xyflow wiring only). */
/** Capabilities a `targets` entry may legally reference, per the kernel rule
 *  (targets must be `Telo.Runnable` or `Telo.Service`). Used to validate
 *  drag-to-wire endpoints on the canvas. */
export const TARGET_CAPABILITIES: ReadonlySet<string> = new Set([
  "Telo.Runnable",
  "Telo.Service",
]);

export interface AppCanvasModel {
  appName: string;
  /** Canvas nodes: the Application root plus every node-capability resource. */
  nodes: GraphNode[];
  /** Labelled edges between canvas nodes (ref edges + Application→target). */
  edges: LabeledEdge[];
  /** "uses" chips for refs to ambient (Provider / Type) targets. */
  chips: UsesChip[];
  /** Provider / Type resources shown in the collapsible side strip. */
  stripItems: GraphNode[];
  /** The Application's current `targets`, filtered to those that resolve to a
   *  node — the authoritative list for add/remove drag-to-wire edits. */
  targets: string[];
}

/** Reconstructs the analyzer-facing manifest shape from a view resource so the
 *  registry's field-map walk can resolve its ref values. */
function toManifest(r: { kind: string; name: string; fields: Record<string, unknown> }): ResourceManifest {
  return { kind: r.kind, metadata: { name: r.name }, ...r.fields } as unknown as ResourceManifest;
}

/**
 * Projects the active module's view data into the overview model. Used for both
 * Application and Library roots — the only difference is `targets` (Library
 * passes `[]`, so it gets no target edges).
 *
 * Nodes and the side strip are partitioned by each resource's capability
 * (node vs. ambient), keyed off `viewData.kinds`, never off kind name. Edges
 * come from `buildOverviewGraph` (capability-classified ref sites) plus one
 * edge per `targets` entry from the root. When the target's kind is unknown the
 * resource is dropped from both partitions, so an unresolved import never
 * crashes the canvas.
 *
 * `targets` entries carry the `!ref <name>` sentinel shape (or, transitionally,
 * a plain string), so each is normalized to a resource name before matching.
 */
export function buildApplicationCanvasModel(
  viewData: ModuleViewData,
  registry: AnalysisRegistry,
  targets: unknown[],
): AppCanvasModel {
  const appName = viewData.manifest.metadata.name;
  const rootKindId = viewData.manifest.kind === "Application" ? APPLICATION_KIND_ID : LIBRARY_KIND_ID;

  // Real resources only — exclude the synthetic module root the adapter
  // prepended; it is added back below as the explicit root node.
  const resources = viewData.manifest.resources.filter((r) => !isModuleRootKind(r.kind));

  const nodes: GraphNode[] = [
    { kind: rootKindId, name: appName, capability: rootKindId, isRoot: true },
  ];
  const stripItems: GraphNode[] = [];
  for (const r of resources) {
    const capability = viewData.kinds.get(r.kind)?.capability;
    if (!capability) continue;
    const node: GraphNode = { kind: r.kind, name: r.name, capability };
    if (NODE_CAPABILITIES.has(capability)) nodes.push(node);
    else if (AMBIENT_CAPABILITIES.has(capability)) stripItems.push(node);
  }

  const overview = buildOverviewGraph(resources.map(toManifest), registry);

  // Root→target edges: one per declared target that resolves to a node.
  // Targets are `!ref <name>` sentinels (or plain strings), so normalize first.
  const nodeNames = new Set(nodes.map((n) => n.name));
  const resolvedTargets = targets
    .map(refTargetName)
    .filter((t): t is string => !!t && nodeNames.has(t));
  const targetEdges: LabeledEdge[] = resolvedTargets.map((t) => ({
    from: appName,
    to: t,
    label: TARGET_EDGE_LABEL,
  }));

  return {
    appName,
    nodes,
    edges: [...targetEdges, ...overview.edges],
    chips: overview.chips,
    stripItems,
    targets: resolvedTargets,
  };
}
