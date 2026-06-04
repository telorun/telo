import type { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";

/** An x-telo-ref whose target is a canvas node (Service / Invocable / Runnable
 *  / Mount). Rendered as a labelled edge between the two nodes. */
export interface LabeledEdge {
  /** Source resource name (the resource that declares the ref). */
  from: string;
  /** Target resource name. */
  to: string;
  /** Field label — the last segment of the ref's field path (e.g. `handler`). */
  label: string;
  /** Concrete path of the ref within the source resource (e.g.
   *  `steps[0].invoke`). Lets a future per-node topology anchor the edge to the
   *  exact location inside the source node instead of its outer handle. */
  fromPath?: string;
  /** True when discovered by value-tree scan (a ref nested behind a `$ref` the
   *  field map doesn't descend, e.g. a Run.Sequence step invoke) — i.e. a
   *  runtime/on-demand ref rather than a top-level boot wiring slot. */
  nested?: boolean;
  /** When the source node renders an internal step topology, the step element
   *  path (`steps[0]`) this edge anchors to — the xyflow source handle id.
   *  Populated by the canvas model from `fromPath`, not the overview builder. */
  fromStepPath?: string;
  /** When the edge's invocation accepts `inputs`, where to edit them: a JSON
   *  pointer into the source resource and the schema to render (the target's
   *  `inputType` when typed, otherwise a freeform map). Populated by the canvas
   *  model. */
  inputs?: { pointer: string; schema: Record<string, unknown> };
}

/** Capabilities whose resources are first-class nodes on the overview canvas —
 *  refs to them render as edges. Application is wired separately (its root is
 *  not a ResourceManifest), so it is not classified here. */
export const NODE_CAPABILITIES: ReadonlySet<string> = new Set([
  "Telo.Service",
  "Telo.Invocable",
  "Telo.Runnable",
  "Telo.Mount",
]);

/** Capabilities whose resources are ambient value / schema sources — the canvas
 *  model renders refs to them as inline picker ports + side-strip entries, never
 *  edges (so `buildOverviewGraph` skips them). */
export const AMBIENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "Telo.Provider",
  "Telo.Type",
]);

/** Extracts the referenced resource name from a ref value, across the three
 *  shapes a ref slot can hold: a `!ref <name>` sentinel, a bare/qualified
 *  string name, or a `{kind, name}` object. Returns undefined for inline
 *  resources and other non-reference values. Also used to normalize Application
 *  `targets` entries, which carry the same `!ref` / string shapes. */
export function refTargetName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (typeof value === "string") {
    const lastDot = value.lastIndexOf(".");
    return lastDot > 0 ? value.slice(lastDot + 1) : value;
  }
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

/** Last segment of a field-map path, with `[]` / `{}` markers stripped —
 *  used as the human-facing edge / chip label (e.g. `routes[].handler` →
 *  `handler`). */
function fieldLabel(fieldPath: string): string {
  const last = fieldPath.split(".").pop() ?? fieldPath;
  return last.replace(/\[\]$/, "").replace(/\{\}$/, "");
}

/**
 * Projects a module's resources into node-to-node edges by subscribing to the
 * manifest visitor's `RefSite` events: every ref whose target is a node
 * capability becomes a labelled edge. Refs to ambient (Provider / Type) targets
 * are skipped — the canvas model surfaces those as inline picker ports.
 *
 * Used now only for refs the model's port enumeration doesn't cover — chiefly
 * step-internal invokes (`steps[].invoke`) nested behind a `$ref`. Top-level
 * refs and Application `targets` come from node ports, not this pass.
 *
 * No resource kind is hardcoded: classification keys off the target
 * definition's capability, resolved generically through the registry.
 */
export function buildOverviewGraph(
  resources: ResourceManifest[],
  registry: AnalysisRegistry,
): LabeledEdge[] {
  // name → kind, so refs given only a name (sentinel / string) can be resolved
  // to their declared kind and thence to a capability.
  const kindByName = new Map<string, string>();
  for (const r of resources) {
    const name = r.metadata?.name;
    if (typeof name === "string" && typeof r.kind === "string") kindByName.set(name, r.kind);
  }

  const edges: LabeledEdge[] = [];

  registry.visitManifest(resources, {
    onRef: (e) => {
      const from = e.source.metadata?.name;
      if (typeof from !== "string") return;

      const targetName = refTargetName(e.value);
      if (!targetName) return;

      // Prefer the kind carried on a {kind,name} ref; fall back to the
      // declared kind of the resource the name resolves to.
      const refKind =
        e.value && typeof e.value === "object"
          ? (e.value as Record<string, unknown>).kind
          : undefined;
      const targetKind = typeof refKind === "string" ? refKind : kindByName.get(targetName);
      if (!targetKind) return;

      const capability = registry.resolveDefinition(targetKind)?.capability;
      if (!capability || !NODE_CAPABILITIES.has(capability)) return;

      edges.push({
        from,
        to: targetName,
        label: fieldLabel(e.fieldPath),
        fromPath: e.concretePath,
        nested: e.nested,
      });
    },
    // `expand` surfaces refs nested behind x-telo-schema-from (matching the
    // validators); `discoverNestedRefs` surfaces refs behind a `$ref` the field
    // map doesn't descend (e.g. Run.Sequence step invokes) so those resources
    // aren't left detached.
  }, { expand: true, discoverNestedRefs: true });

  return edges;
}
