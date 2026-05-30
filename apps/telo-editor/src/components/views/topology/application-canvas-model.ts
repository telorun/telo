import type { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import {
  APPLICATION_KIND_ID,
  LIBRARY_KIND_ID,
  isModuleRootKind,
} from "../../../application-adapter";
import { isRecord } from "../../../lib/utils";
import type { ModuleViewData } from "../../../model";
import {
  getTopologyRole,
  getVariants,
  matchVariant,
  resolveRef,
  type VariantMeta,
} from "../../../schema-utils";
import {
  AMBIENT_CAPABILITIES,
  NODE_CAPABILITIES,
  buildOverviewGraph,
  refTargetName,
  type LabeledEdge,
  type UsesChip,
} from "./overview-graph";

/** A single step rendered inside a sequence-like node. Each step owns a source
 *  handle on the node so an edge can anchor to the exact invoke it came from
 *  instead of the node's outer handle. */
export interface NodeStep {
  /** Concrete path of the step element (`steps[0]`, `steps[1].do[3]`) — used as
   *  the source-handle anchor and the prefix edges match their `fromPath`
   *  against. */
  path: string;
  /** Step name (`step.name`), or a fallback when unnamed. */
  name: string;
  /** Short descriptor: the invoke target name, or a control-flow keyword. */
  detail?: string;
  /** Nesting depth — 0 for top-level steps, +1 inside each branch / case /
   *  loop body. Drives the row's indentation. */
  depth: number;
}

/** A resource rendered as a graph node or a side-strip entry. */
export interface GraphNode {
  kind: string;
  name: string;
  capability: string;
  /** True for the synthetic module root node (Application or Library). */
  isRoot?: boolean;
  /** Steps when the kind declares an `x-telo-topology-role: steps` field (e.g.
   *  Run.Sequence); omitted for plain nodes. Nested branch / case / loop bodies
   *  are flattened into their own depth-indented rows (see `NodeStep.depth`),
   *  each keeping its full concrete path. */
  steps?: NodeStep[];
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

function stepLabel(step: Record<string, unknown>): string {
  return typeof step.name === "string" && step.name ? step.name : "step";
}

/** B1-flat descriptor for one step: an invocable step shows its target name; a
 *  control-flow step shows its keyword (first segment of the variant title). */
function stepDetail(step: Record<string, unknown>, variant: VariantMeta | null): string | undefined {
  if (variant?.invokeField) return refTargetName(step[variant.invokeField]);
  const title = variant?.title?.trim();
  return title ? title.split("/")[0].trim() : undefined;
}

/** The field carrying a branch-list entry's nested steps (role `branch`),
 *  e.g. `elseif[].then`. Falls back to `then` when the schema doesn't name it. */
function branchListBranchKey(
  variant: VariantMeta,
  field: string,
  root: Record<string, unknown>,
): string {
  const props = isRecord(variant.schema.properties) ? variant.schema.properties : {};
  const listProp = isRecord(props[field]) ? props[field] : {};
  const items = resolveRef(listProp.items, root);
  if (isRecord(items) && isRecord(items.properties)) {
    for (const [k, p] of Object.entries(items.properties)) {
      if (getTopologyRole(p) === "branch") return k;
    }
  }
  return "then";
}

/** Recursively flattens a step list into ordered rows, descending into every
 *  branch (`do` / `then` / `else`), case map (`cases`), and branch list
 *  (`elseif`). Each row carries its full concrete `path` so an edge anchors to
 *  the exact invoke it came from, and a `depth` for indentation. */
function collectSteps(
  steps: unknown[],
  variants: VariantMeta[],
  root: Record<string, unknown>,
  parentPath: string,
  depth: number,
  out: NodeStep[],
): void {
  steps.forEach((step, i) => {
    const r = isRecord(step) ? step : {};
    const variant = matchVariant(r, variants);
    const path = `${parentPath}[${i}]`;
    out.push({ path, name: stepLabel(r), detail: stepDetail(r, variant), depth });
    if (!variant) return;

    for (const f of variant.branchFields) {
      const arr = Array.isArray(r[f]) ? r[f] : [];
      collectSteps(arr, variants, root, `${path}.${f}`, depth + 1, out);
    }
    for (const f of variant.caseMaps) {
      const cases = isRecord(r[f]) ? r[f] : {};
      for (const [key, val] of Object.entries(cases)) {
        const arr = Array.isArray(val) ? val : [];
        collectSteps(arr, variants, root, `${path}.${f}.${key}`, depth + 1, out);
      }
    }
    for (const f of variant.branchLists) {
      const entries = Array.isArray(r[f]) ? r[f] : [];
      const branchKey = branchListBranchKey(variant, f, root);
      entries.forEach((entry, k) => {
        const arr = isRecord(entry) && Array.isArray(entry[branchKey]) ? entry[branchKey] : [];
        collectSteps(arr, variants, root, `${path}.${f}[${k}].${branchKey}`, depth + 1, out);
      });
    }
  });
}

/** Enumerates every step of a node whose kind schema declares an
 *  `x-telo-topology-role: steps` field — fully annotation-driven, no kind name.
 *  Returns [] for plain nodes. Nested steps (loop / branch bodies) are flattened
 *  with a `depth`, each keeping its full concrete path so edges anchor to the
 *  exact invoke. */
function buildNodeSteps(
  fields: Record<string, unknown>,
  kindSchema: Record<string, unknown>,
): NodeStep[] {
  const props = kindSchema.properties;
  if (!isRecord(props)) return [];

  let field: string | null = null;
  let itemsSchema: Record<string, unknown> | null = null;
  for (const [name, prop] of Object.entries(props)) {
    if (getTopologyRole(prop) === "steps" && isRecord(prop)) {
      field = name;
      const items = resolveRef(prop.items, kindSchema);
      itemsSchema = isRecord(items) ? items : null;
      break;
    }
  }
  if (!field || !itemsSchema) return [];

  const raw = fields[field];
  const steps: unknown[] = Array.isArray(raw) ? raw : [];
  const variants = getVariants(itemsSchema, kindSchema);
  const out: NodeStep[] = [];
  collectSteps(steps, variants, kindSchema, field, 0, out);
  return out;
}

/** Picks the source-handle anchor for an edge: the longest step path that is a
 *  prefix of the edge's concrete ref `fromPath`, so a nested invoke anchors to
 *  its top-level step (B1). Undefined when the node has no steps or the ref
 *  isn't inside one — the edge then docks on the node's outer handle. */
function anchorStep(steps: NodeStep[] | undefined, fromPath: string | undefined): string | undefined {
  if (!steps || !fromPath) return undefined;
  let best: string | undefined;
  for (const s of steps) {
    const inside =
      fromPath === s.path || fromPath.startsWith(s.path + ".") || fromPath.startsWith(s.path + "[");
    if (inside && (!best || s.path.length > best.length)) best = s.path;
  }
  return best;
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
    const kindData = viewData.kinds.get(r.kind);
    const capability = kindData?.capability;
    if (!capability) continue;
    const node: GraphNode = { kind: r.kind, name: r.name, capability };
    if (NODE_CAPABILITIES.has(capability)) {
      const steps = kindData ? buildNodeSteps(r.fields, kindData.schema) : [];
      if (steps.length) node.steps = steps;
      nodes.push(node);
    } else if (AMBIENT_CAPABILITIES.has(capability)) stripItems.push(node);
  }

  const overview = buildOverviewGraph(resources.map(toManifest), registry);

  // Anchor each ref edge to the step it originates from, when the source node
  // renders an internal step topology.
  const stepsByNode = new Map(
    nodes.filter((n) => n.steps?.length).map((n) => [n.name, n.steps!] as const),
  );
  const refEdges: LabeledEdge[] = overview.edges.map((e) => ({
    ...e,
    fromStepPath: anchorStep(stepsByNode.get(e.from), e.fromPath),
  }));

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
    edges: [...targetEdges, ...refEdges],
    chips: overview.chips,
    stripItems,
    targets: resolvedTargets,
  };
}
