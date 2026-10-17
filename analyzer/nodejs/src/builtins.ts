import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { BUILTIN_DOCUMENT_FILES } from "./builtin-entries/index.js";
import { refuseRosterMarkers } from "./builtin-entry-markers.js";
import { declarableCapabilities } from "./capability-roster.js";
import { effectiveAuthorSchema } from "./extends-resolution.js";
import { expandManifestFragments } from "./manifest-schemas.js";
import { needTypeDefinition } from "./need-type.js";

/**
 * THE BUILT-IN VOCABULARY, registered — every kind that needs no import, read
 * from the entries of `sdk/builtins/` (derived into `builtin-entries/` by
 * `scripts/render-builtin-vocabulary.mjs`) the way any module's documents are
 * read.
 *
 * An entry is the built-in in its AUTHORED form: it names no module (it is the
 * module `Telo`), carries its fragment references unexpanded, declares only its
 * own fields where it `extends` another built-in, and carries no `controllers:`.
 * Registration supplies what a loader would: the module name, the expanded
 * fragments, a need type's synthesized kind, the author-facing schema of an
 * `extends` child, and the marker saying the kernel implements the kind.
 */

/** The marker a kernel-implemented built-in carries: the kind reads as
 *  controller-bearing, so another definition can inherit it by delegation. The
 *  entry is never loaded from — the kernel registers each such controller
 *  directly at boot — it states truthfully who provides the kind. */
function kernelImplemented(name: string): Array<Record<string, string>> {
  return [{ runtime: "kernel", entry: `Telo.${name}` }];
}

const DECLARABLE: ReadonlySet<unknown> = new Set(declarableCapabilities());

/** Register built-in documents in their authored, derived form, each named by
 *  where it was read from. What the analyzer runs on is this over the entries;
 *  the archive's round-trip test is this over the archive's documents. */
export function builtinDefinitions(
  entries: ReadonlyArray<readonly [where: string, data: unknown]>,
): ResourceDefinition[] {
  const documents = entries.map(([where, data]) => {
    refuseRosterMarkers(data, where);
    const doc = structuredClone(data) as Record<string, any>;
    if (doc.controllers !== undefined) {
      throw new Error(
        `${where}: a built-in carries no 'controllers:' — the kernel implements every one.`,
      );
    }
    doc.metadata = { ...doc.metadata, module: "Telo" };
    return doc;
  });

  const definitions = documents.map((doc): ResourceDefinition => {
    if (doc.kind === "Telo.NeedType") return needTypeDefinition(doc as ResourceManifest);
    expandManifestFragments(doc);
    // Every built-in definition whose capability is a declarable role is
    // implemented by the kernel; a `Telo.Template` document is read by the
    // loader, never instantiated, so it is not marked.
    if (doc.kind === "Telo.Definition" && DECLARABLE.has(doc.capability)) {
      doc.controllers = kernelImplemented(doc.metadata.name);
    }
    return doc as ResourceDefinition;
  });

  // An `extends` child declares only its own fields; what every reader validates
  // an instance against is merge(parent, own), stamped here exactly as the
  // kernel stamps it when a module's definition registers.
  const byKind = new Map<string, ResourceDefinition>(
    definitions.map((def) => [`${def.metadata.module}.${def.metadata.name}`, def]),
  );
  for (const def of definitions) {
    if (def.kind !== "Telo.Definition" || typeof def.extends !== "string") continue;
    def.schema = effectiveAuthorSchema(def, (kind) => byKind.get(kind));
  }
  return definitions;
}

export const KERNEL_BUILTINS: ResourceDefinition[] = builtinDefinitions(
  BUILTIN_DOCUMENT_FILES.map(([file, data]) => [`sdk/builtins/${file}`, data] as const),
);

/** The schema a built-in document kind validates its documents against — the
 *  one `telo check` applies and the kernel validates a `Telo.Definition` /
 *  `Telo.Abstract` with at registration. */
export function builtinDocumentSchema(name: string): Record<string, unknown> {
  const definition = KERNEL_BUILTINS.find(
    (def) => def.kind === "Telo.Definition" && def.metadata.name === name,
  );
  if (!definition?.schema) throw new Error(`No built-in document kind 'Telo.${name}'.`);
  return definition.schema as Record<string, unknown>;
}
