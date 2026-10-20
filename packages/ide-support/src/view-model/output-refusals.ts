import {
  isModuleKind,
  isRefSlot,
  kindDeclarationOf,
  readRefSlot,
  type AnalysisRegistry,
  type ManifestAnalysis,
  type RefSlot,
} from "@telorun/analyzer";
import type { OutputRefusals } from "@telorun/editor-protocol";
import type { ResourceManifest } from "@telorun/sdk";

/** A reference slot declaring an `outputType`, where it sits in its kind's schema. */
export interface OutputSlotSite {
  /** JSON Pointer of the node the slot is read from, within the schema walked. */
  pointer: string;
  slot: RefSlot;
}

/** A slot site of one kind. */
export interface KindOutputSlot extends OutputSlotSite {
  /** The canonical kind whose schema declares it. */
  kind: string;
}

/**
 * Every node of a kind's `schema` read as a reference slot declaring an
 * `outputType`, with its JSON Pointer there. The pointer is the slot's address
 * a host and an engine both derive from the schema as its author wrote it — an
 * `outputType` itself is not, since the engine reads it after migration.
 */
export function outputSlotSites(schema: unknown): OutputSlotSite[] {
  const out: OutputSlotSite[] = [];
  const onPath = new Set<object>();
  const walk = (node: unknown, pointer: string): void => {
    if (!node || typeof node !== "object" || onPath.has(node)) return;
    onPath.add(node);
    if (!Array.isArray(node) && isRefSlot(node as Record<string, any>)) {
      const slot = readRefSlot(node as Record<string, any>);
      if (slot?.outputType) out.push({ pointer, slot });
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${pointer}/${escapePointerSegment(key)}`);
    onPath.delete(node);
  };
  walk(schema, "");
  return out;
}

/** Every output-constrained slot the analysed kinds declare — each registered
 *  definition's schema as registered, and each kind document's as analysed. */
export function declaredOutputSlots(
  registry: AnalysisRegistry,
  manifests: readonly ResourceManifest[],
): KindOutputSlot[] {
  const byKey = new Map<string, KindOutputSlot>();
  const add = (kind: string, schema: unknown) => {
    for (const site of outputSlotSites(schema)) {
      const key = `${kind}#${site.pointer}`;
      if (!byKey.has(key)) byKey.set(key, { kind, ...site });
    }
  };
  for (const kind of registry.allKinds()) add(kind, registry.resolveDefinition(kind)?.schema);
  for (const m of manifests) {
    const declaration = kindDeclarationOf(m);
    const name = m.metadata?.name;
    if (!declaration || typeof name !== "string") continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    add(module ? `${module}.${name}` : name, declaration.schema);
  }
  return [...byKey.values()];
}

/** The named resources of `manifests` a slot could be filled with. */
export function outputCandidates(manifests: readonly (ResourceManifest | null)[]): { kind: string; name: string }[] {
  return manifests.flatMap((m) => {
    if (!m || typeof m.kind !== "string" || isModuleKind(m.kind) || m.kind === "Telo.Import") return [];
    const name = m.metadata?.name;
    return typeof name === "string" ? [{ kind: m.kind, name }] : [];
  });
}

/** Per slot, why each candidate cannot fill it by what it returns — the
 *  analysis's own `REFERENCE_OUTPUT_MISMATCH` verdict. */
export function outputRefusalsOf(
  analysis: ManifestAnalysis,
  slots: readonly KindOutputSlot[],
  candidates: readonly { kind: string; name: string }[],
): OutputRefusals[] {
  return slots.map(({ kind, pointer, slot }) => {
    const refusals: Record<string, string[]> = {};
    for (const candidate of candidates) {
      const lines = analysis.outputRefusal(slot, candidate);
      if (lines.length > 0) refusals[candidate.name] = lines;
    }
    return { kind, pointer, refusals };
  });
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
