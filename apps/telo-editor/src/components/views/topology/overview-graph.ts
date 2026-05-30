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
}

/** An x-telo-ref whose target is an ambient value / schema source (Provider /
 *  Type). Rendered as a "uses" chip on the source node, with the target shown
 *  in the side strip rather than as a graph node. */
export interface UsesChip {
  /** Source resource name. */
  on: string;
  /** Target provider / type resource name. */
  target: string;
  /** Field label — the last segment of the ref's field path. */
  label: string;
  /** Concrete path of the ref within the source resource. */
  fromPath?: string;
}

export interface OverviewGraph {
  edges: LabeledEdge[];
  chips: UsesChip[];
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

/** Capabilities whose resources are ambient value / schema sources — refs to
 *  them render as "uses" chips + side-strip entries, not edges. */
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
 * Projects a module's resources into the overview graph's data model by
 * subscribing to the manifest visitor's `RefSite` events. Each ref is split by
 * its target's capability: node-capability targets become labelled edges,
 * ambient (Provider / Type) targets become "uses" chips.
 *
 * Application↔target edges are NOT produced here — the Application root is not a
 * ResourceManifest and does not ride the visitor's iteration surface; the
 * caller constructs those edges directly from `manifest.targets`.
 *
 * No resource kind is hardcoded: classification keys off the target
 * definition's capability, resolved generically through the registry.
 */
export function buildOverviewGraph(
  resources: ResourceManifest[],
  registry: AnalysisRegistry,
): OverviewGraph {
  // name → kind, so refs given only a name (sentinel / string) can be resolved
  // to their declared kind and thence to a capability.
  const kindByName = new Map<string, string>();
  for (const r of resources) {
    const name = r.metadata?.name;
    if (typeof name === "string" && typeof r.kind === "string") kindByName.set(name, r.kind);
  }

  const edges: LabeledEdge[] = [];
  const chips: UsesChip[] = [];

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
      if (!capability) return;

      const label = fieldLabel(e.fieldPath);
      if (NODE_CAPABILITIES.has(capability)) {
        edges.push({ from, to: targetName, label, fromPath: e.concretePath, nested: e.nested });
      } else if (AMBIENT_CAPABILITIES.has(capability)) {
        chips.push({ on: from, target: targetName, label, fromPath: e.concretePath });
      }
    },
    // `expand` surfaces refs nested behind x-telo-schema-from (matching the
    // validators); `discoverNestedRefs` surfaces refs behind a `$ref` the field
    // map doesn't descend (e.g. Run.Sequence step invokes) so those resources
    // aren't left detached.
  }, { expand: true, discoverNestedRefs: true });

  return { edges, chips };
}
