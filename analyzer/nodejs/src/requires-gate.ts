import type { ResourceManifest } from "@telorun/sdk";
import { isModuleKind } from "./module-kinds.js";
import type { ModuleDocuments } from "./module-documents.js";
import { fileCoverKey } from "./finishing-pipeline.js";
import type { CarriedCover } from "./placement.js";
import type { AnalysisDiagnostic, DiagnosticData } from "./types.js";
import { RUNTIME_GATE_CODES } from "./validate-requires.js";

/**
 * Files belonging to a module this runtime declared itself unable to read.
 *
 * Attribution is by FILE rather than by resource identity, the same choice
 * `remapMigratedPaths` makes and for the same reason: a diagnostic carries at
 * most two routing facts and routinely only one, so indexing by resource would
 * leave every diagnostic without `data.resource` unreachable.
 *
 * **A module NAME is not a graph-unique key.** Names are module-scoped, so two
 * libraries may both be called `Store` — CLAUDE.md names this exact hazard for
 * migration provenance ("two libraries declaring a Store would share one
 * bucket"), where the answer is to narrow or not remap at all. Same answer here:
 * the gated doc's own `metadata.source` is always suppressed, and a name is used
 * to reach its `include:` partials only when that name identifies exactly ONE
 * module doc in the set. Where it does not, the partials keep their diagnostics
 * rather than risk silencing an unrelated library's — a stray extra diagnostic is
 * a far cheaper failure than a hidden one.
 *
 * A module doc with no `source` contributes nothing — suppressing on a guess
 * would hide diagnostics belonging to files nobody named.
 */
export function filesOfUnreadableModules(
  manifests: readonly ResourceManifest[],
  requiresDiagnostics: readonly AnalysisDiagnostic[],
): ReadonlySet<string> {
  const files = new Set<string>();
  const gatedNames = new Set<string>();

  for (const d of requiresDiagnostics) {
    if (!RUNTIME_GATE_CODES.has(String(d.code))) continue;
    const data = d.data as DiagnosticData | undefined;
    // The gated document itself, addressed by the file it was declared in.
    if (typeof data?.filePath === "string" && data.filePath) files.add(data.filePath);
    const name = data?.resource?.name;
    if (typeof name === "string") gatedNames.add(name);
  }
  if (files.size === 0 && gatedNames.size === 0) return files;

  // How many module docs answer to each gated name — the ambiguity test.
  const docsPerName = new Map<string, number>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Application" && m.kind !== "Telo.Library") continue;
    const name = (m.metadata as { name?: string } | undefined)?.name;
    if (typeof name === "string" && gatedNames.has(name)) {
      docsPerName.set(name, (docsPerName.get(name) ?? 0) + 1);
    }
  }

  for (const m of manifests) {
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const owner = metadata.module;
    if (typeof owner !== "string" || !gatedNames.has(owner)) continue;
    if (docsPerName.get(owner) !== 1) continue; // ambiguous — do not guess
    if (typeof metadata.source === "string" && metadata.source) files.add(metadata.source);
  }
  return files;
}

/**
 * The module documents the requires gate judges besides the analysed set's
 * own: the `Telo.Library` doc of every imported library the load reaches. The
 * flat analysis list forwards a library's declarations and drops its module doc,
 * so those are read from `moduleDocuments` — each kept only when the entry's
 * import edges reach it (`reached`; a version reconciliation replaced the rest).
 * A producer that did not read the edges leaves it absent, and the library is
 * then kept when one of its files contributed to the analysed set.
 */
export function reachedLibraryDocuments(
  manifests: readonly ResourceManifest[],
  moduleDocuments: readonly ModuleDocuments[] | undefined,
): ResourceManifest[] {
  if (!moduleDocuments || moduleDocuments.length === 0) return [];
  const reached = new Set<string>();
  for (const m of manifests) {
    const source = (m.metadata as { source?: unknown } | undefined)?.source;
    if (typeof source === "string") reached.add(source);
  }
  return moduleDocuments.flatMap((docs) =>
    (docs.reached ??
    docs.manifests.some((m) => reached.has((m.metadata as { source?: string } | undefined)?.source ?? "")))
      ? docs.manifests.filter((m) => isModuleKind(m.kind))
      : [],
  );
}

/** The module documents the requires gate judges: the analysed set's own plus
 *  {@link reachedLibraryDocuments}. */
export function requiresGateInput(
  manifests: readonly ResourceManifest[],
  moduleDocuments: readonly ModuleDocuments[] | undefined,
): ResourceManifest[] {
  return [...manifests, ...reachedLibraryDocuments(manifests, moduleDocuments)];
}

/**
 * The refusal a runtime gate diagnostic is: every diagnostic anchored in a file
 * whose module this runtime cannot read holds only where the gate does not —
 * except the gate diagnostic itself.
 *
 * A cover rather than a guard on each validator: threading "skip this module"
 * through thirty validators would make each one responsible for a rule none of
 * them owns, and a validator added later would silently opt out of it. A
 * diagnostic with no `filePath` is never covered — suppression must never be
 * the default for something it cannot attribute.
 */
export function unreadableModuleRefusals(
  unreadableFiles: ReadonlySet<string>,
): (d: AnalysisDiagnostic) => readonly CarriedCover[] | undefined {
  if (unreadableFiles.size === 0) return () => undefined;
  return (d) => (RUNTIME_GATE_CODES.has(String(d.code)) ? [coverOfFiles(unreadableFiles)] : undefined);
}

/** The same refusal read per gate finding over every configuration: each
 *  carries the files of the module it gates, and so covers them where it holds. */
export function gateRefusals(
  manifests: readonly ResourceManifest[],
): (d: AnalysisDiagnostic) => readonly CarriedCover[] | undefined {
  return (d) => {
    if (!RUNTIME_GATE_CODES.has(String(d.code))) return undefined;
    const files = filesOfUnreadableModules(manifests, [d]);
    return files.size === 0 ? undefined : [coverOfFiles(files)];
  };
}

function coverOfFiles(files: ReadonlySet<string>): CarriedCover {
  return {
    keys: [...files].map(fileCoverKey),
    covers: (d, provenance) =>
      !RUNTIME_GATE_CODES.has(String(d.code)) && typeof provenance?.file === "string" && files.has(provenance.file),
  };
}
