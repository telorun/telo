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
import { resolveEdgeInputs } from "./edge-inputs";
import { buildNodePorts, type NodePort } from "./node-ports";
import {
  AMBIENT_CAPABILITIES,
  NODE_CAPABILITIES,
  buildOverviewGraph,
  refTargetName,
  type LabeledEdge,
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
  /** Reference fields rendered as adapters on the node — edge ports (drag-to-
   *  wire) and picker ports (inline select for ambient targets). Drives both the
   *  rendered rail and the edges that dock onto it. */
  ports?: NodePort[];
}

/** A single reference write the canvas asks the host to apply: set (or, when
 *  `target` is null, clear / splice) the ref slot at `concretePath` on the
 *  source resource. Drag-to-wire, edge deletion, and picker changes all emit
 *  these — the one generic mutation the overview canvas performs. */
export interface RefWrite {
  source: { kind: string; name: string };
  concretePath: string;
  target: string | null;
  /** When set, create a new resource of this kind, then link the slot to it
   *  (instead of `target`). The host generates a unique name. */
  createKind?: string;
}

/** The full data model the Application overview canvas renders. Pure data —
 *  computed once from view data + the analysis registry, then handed to the
 *  renderer (which owns layout + xyflow wiring only). */
export interface AppCanvasModel {
  appName: string;
  /** Canvas nodes: the Application root plus every node-capability resource. */
  nodes: GraphNode[];
  /** Edges between canvas nodes, each docked to the source node's port (or step)
   *  handle via `fromPath` / `fromStepPath`. Labels live on the ports, not the
   *  edges. */
  edges: LabeledEdge[];
  /** Provider / Type resources shown in the collapsible side strip. */
  stripItems: GraphNode[];
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
/** Name of the `x-telo-topology-role: steps` field on a kind schema, or null.
 *  Drives both step rendering and the exclusion of step-internal refs from the
 *  node's port rail (they render as step rows with their own handles). */
function findStepsField(kindSchema: Record<string, unknown>): string | null {
  const props = kindSchema.properties;
  if (!isRecord(props)) return null;
  for (const [name, prop] of Object.entries(props)) {
    if (getTopologyRole(prop) === "steps") return name;
  }
  return null;
}

function buildNodeSteps(
  fields: Record<string, unknown>,
  kindSchema: Record<string, unknown>,
): NodeStep[] {
  const props = kindSchema.properties;
  if (!isRecord(props)) return [];

  const field = findStepsField(kindSchema);
  const prop = field && isRecord(props[field]) ? (props[field] as Record<string, unknown>) : null;
  const items = prop ? resolveRef(prop.items, kindSchema) : null;
  const itemsSchema = isRecord(items) ? items : null;
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

/** Edges from a node's edge-flavor ports: one per filled slot, docked to the
 *  port's handle via `fromPath` (the slot's concrete path). */
function edgesFromPorts(nodeName: string, ports: NodePort[], nodeNames: Set<string>): LabeledEdge[] {
  const out: LabeledEdge[] = [];
  for (const port of ports) {
    if (port.flavor !== "edge") continue;
    for (const slot of port.slots) {
      if (slot.target && nodeNames.has(slot.target)) {
        out.push({ from: nodeName, to: slot.target, label: port.label, fromPath: slot.concretePath });
      }
    }
  }
  return out;
}

/**
 * Projects the active module's view data into the overview model. Used for both
 * Application and Library roots — the only difference is `targets` (a Library
 * has none, so its root node gets no `targets` port).
 *
 * Nodes and the side strip are partitioned by each resource's capability
 * (node vs. ambient), keyed off `viewData.kinds`, never off kind name. Every
 * node's reference fields are projected into ports (`buildNodePorts`) from the
 * registry's field map: node-capability refs become edge ports that draw edges,
 * ambient refs become inline picker ports. The Application root's `targets`
 * field is an ordinary array-of-refs port — no special-casing.
 *
 * Edges come from each node's edge ports plus the step-internal refs the
 * manifest visitor discovers (anchored to their step handle). When a target's
 * kind is unknown the resource is dropped from both partitions, so an
 * unresolved import never crashes the canvas.
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

  // The root node's reference fields (the Application's `targets`) come from the
  // builtin Telo.Application schema's field map, fed its actual `targets`.
  const rootManifest: ResourceManifest = {
    kind: rootKindId,
    metadata: { name: appName },
    targets,
  } as unknown as ResourceManifest;
  const rootSchema = viewData.kinds.get(rootKindId)?.schema;
  const rootPorts = buildNodePorts(
    registry.refFieldsForResource(rootManifest),
    { targets },
    null,
    rootSchema,
  );

  const nodes: GraphNode[] = [
    { kind: rootKindId, name: appName, capability: rootKindId, isRoot: true, ports: rootPorts },
  ];
  // Per-node kind / schema / field values — feeds edge `inputs` resolution.
  const nodeInfo = new Map<
    string,
    { kind: string; schema?: Record<string, unknown>; fields: Record<string, unknown> }
  >([[appName, { kind: rootKindId, schema: rootSchema, fields: { targets } }]]);
  const stripItems: GraphNode[] = [];
  for (const r of resources) {
    const kindData = viewData.kinds.get(r.kind);
    const capability = kindData?.capability;
    if (!capability) continue;
    const node: GraphNode = { kind: r.kind, name: r.name, capability };
    if (NODE_CAPABILITIES.has(capability)) {
      const stepsField = kindData ? findStepsField(kindData.schema) : null;
      const steps = kindData ? buildNodeSteps(r.fields, kindData.schema) : [];
      if (steps.length) node.steps = steps;
      node.ports = buildNodePorts(
        registry.refFieldsForResource(toManifest(r)),
        r.fields,
        stepsField,
        kindData?.schema,
      );
      nodes.push(node);
      nodeInfo.set(r.name, { kind: r.kind, schema: kindData?.schema, fields: r.fields });
    } else if (AMBIENT_CAPABILITIES.has(capability)) stripItems.push(node);
  }

  // Picker ports select among the ambient (Provider / Type) resources that
  // match their capability — surface those names as candidates. Edge `+` slots
  // can create-and-link any user-facing kind that satisfies the port's refs.
  for (const n of nodes) {
    for (const port of n.ports ?? []) {
      if (port.flavor === "picker") {
        port.candidates = stripItems
          .filter((s) => port.capabilities.includes(s.capability))
          .map((s) => s.name);
      } else if (port.addPath) {
        const kinds = new Set<string>();
        for (const ref of port.refs) {
          for (const k of registry.userFacingKindsForRef(ref) ?? []) kinds.add(k);
        }
        if (kinds.size) port.createKinds = [...kinds].sort();
      }
    }
  }

  const nodeNames = new Set(nodes.map((n) => n.name));

  // Edges from every node's edge ports (includes the root's `targets`).
  const portEdges = nodes.flatMap((n) => (n.ports ? edgesFromPorts(n.name, n.ports, nodeNames) : []));

  // Concrete ref sites already covered by a port edge — so the visitor's
  // duplicate top-level edges are dropped and only step-internal refs remain.
  const portSites = new Set(portEdges.map((e) => `${e.from}::${e.fromPath}`));

  // Step-internal refs the visitor discovers (e.g. `steps[].invoke`), anchored
  // to their step handle. Top-level refs are already port edges, so skip them.
  const stepsByNode = new Map(
    nodes.filter((n) => n.steps?.length).map((n) => [n.name, n.steps!] as const),
  );
  const stepEdges: LabeledEdge[] = buildOverviewGraph(resources.map(toManifest), registry)
    .filter((e) => !portSites.has(`${e.from}::${e.fromPath}`))
    .map((e) => ({ ...e, fromStepPath: anchorStep(stepsByNode.get(e.from), e.fromPath) }));

  // Attach editable `inputs` to edges whose invocation object declares them. The
  // schema is the target's typed `inputType` when available, else the source's
  // declared (usually freeform) inputs schema.
  const edges = [...portEdges, ...stepEdges].map((e) => {
    const src = nodeInfo.get(e.from);
    if (!src?.schema || !e.fromPath) return e;
    const found = resolveEdgeInputs(src.schema, src.fields, e.fromPath);
    if (!found) return e;
    const targetKind = nodeInfo.get(e.to)?.kind;
    const inputType = targetKind ? registry.inputTypeForKind(targetKind) : undefined;
    const schema = inputType ?? found.inputsProp;
    return { ...e, inputs: { pointer: found.pointer, schema } };
  });

  return { appName, nodes, edges, stripItems };
}
