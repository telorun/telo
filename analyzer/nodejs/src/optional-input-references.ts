/**
 * A reference to a library's `optional: true` resource input where it may be
 * absent — `RESOURCE_INPUT_OPTIONAL_REFERENCED`, the one reader both halves ask.
 *
 * An optional input exists only in the configurations its importer supplies it
 * in, so a `!ref <input>` holds an instance only inside a branch proving it
 * present (`!if` on `resources.<input> != null`). Read off the call graph, so
 * every reference the kernel would resolve — a reference slot, a step's target,
 * a reference found in a value, a scope member's — is one, resolved by the
 * scoped name rule (a scope member shadowing the input is not it); and off each
 * import's `resources:`, which can forward the input to a library it imports
 * but sits in no branch.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { CallGraph } from "./call-graph.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isOptionalResourceInput, readSuppliedResources } from "./resource-input.js";
import { isResolvedReference } from "./resolved-reference.js";

export interface OptionalInputReference {
  /** The resource input referenced. */
  readonly input: string;
  /** The declaration holding the reference — a `Telo.Import` forwarding it. */
  readonly holder: ResourceManifest;
  /** Where it is written in the holder. */
  readonly path: string;
}

const moduleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

/** Every reference to an optional resource input `absent` says may be absent
 *  in the set `graph` was built over, in written order. */
export function optionalInputReferences(
  manifests: readonly ResourceManifest[],
  graph: CallGraph,
  absent: (module: string | undefined, input: string) => boolean,
): OptionalInputReference[] {
  const out: OptionalInputReference[] = [];
  for (const edge of graph.edges) {
    if (!edge.to || edge.moduleCall) continue;
    const target = graph.nodes.get(edge.to);
    if (target?.type !== "resource" || !isOptionalResourceInput(target.manifest)) continue;
    if (!absent(moduleOf(target.manifest), target.name)) continue;
    const from = graph.nodes.get(edge.from);
    const holder =
      from?.type === "resource"
        ? from.manifest
        : from?.type === "step"
          ? (graph.nodes.get(from.owner) as { manifest?: ResourceManifest } | undefined)?.manifest
          : undefined;
    if (holder) out.push({ input: target.name, holder, path: edge.path });
  }

  const optional = new Set<string>();
  for (const m of manifests) {
    if (isOptionalResourceInput(m)) optional.add(`${moduleOf(m) ?? ""}\0${m.metadata?.name}`);
  }
  if (optional.size === 0) return out;
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const module = moduleOf(m);
    for (const [key, value] of Object.entries(readSuppliedResources(m))) {
      const target = refSentinelTarget(value) ?? (isResolvedReference(value) ? value : undefined);
      if (!target || (target.alias !== undefined && target.alias !== "Self")) continue;
      if (!optional.has(`${module ?? ""}\0${target.name}`) || !absent(module, target.name)) continue;
      out.push({ input: target.name, holder: m, path: `resources.${key}` });
    }
  }
  return out;
}

/** What a reference is refused with, in both halves. */
export function optionalInputReferenceMessage(reference: OptionalInputReference): string {
  const { holder, input, path } = reference;
  const at =
    holder.kind === "Telo.Import"
      ? `Import '${holder.metadata?.name}': '${path}' forwards`
      : `${holder.kind}/${holder.metadata?.name}: '${path}' references`;
  return (
    `${at} resource input '${input}', which is optional and may be absent. Reference it only ` +
    `inside an '!if' proving it present ('resources.${input} != null'), with this library's own ` +
    `default in the other branch, or make the input required.`
  );
}
