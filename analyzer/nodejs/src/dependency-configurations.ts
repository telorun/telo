import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isExpansionSentinel, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { ABSENT, memberOfValue, PRESENT, type Assignment } from "./configuration-dimensions.js";
import { edgesFrom } from "./flatten-for-analyzer.js";
import type { LoadedGraph } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { needSupplyOf, readNeeds, readSuppliedNeeds } from "./need-type.js";
import { readResourceInputs, readSuppliedResources } from "./resource-input.js";
import type { AnalysisDiagnostic } from "./types.js";

/**
 * Which of a library's own findings an application can reach, by the
 * configurations each holds in (`data.configurations`, in the library's own
 * dimensions) against what each import of the library fixes. Conservative: a
 * dimension an import does not fix with a literal — an expression, a need left
 * to the environment or forwarded whole, a member no literal reads — agrees with
 * every value, so a finding is dropped only when no import can reach it.
 * Browser-safe.
 */

/** One import of a library, as the declaring file holds it. */
type ImportDocument = Record<string, unknown>;

/** Every import reaching the library at `librarySource`, from every module the
 *  entry reaches: its `imports:` entries and its scope members. */
export function importsOfLibrary(graph: LoadedGraph, reached: Iterable<string>, librarySource: string): ImportDocument[] {
  const out: ImportDocument[] = [];
  for (const source of reached) {
    const mod = graph.modules.get(source);
    if (!mod) continue;
    for (const edge of edgesFrom(graph, source)) {
      if (edge.targetSource !== librarySource) continue;
      if ("member" in edge) {
        out.push(edge.member);
        continue;
      }
      const doc = mod.owner.manifests.find((m) => m?.kind === "Telo.Import" && m.metadata?.name === edge.alias);
      if (doc) out.push(doc as unknown as ImportDocument);
    }
  }
  return out;
}

/** Whether a dependency's finding holds in a configuration some import of the
 *  library reaches. A finding with no `configurations` holds in all of them; an
 *  empty list — a branch no configuration takes — in none. */
export function reachableByImports(
  diagnostic: AnalysisDiagnostic,
  libraryDoc: ResourceManifest | undefined,
  imports: readonly ImportDocument[],
): boolean {
  const entries = (diagnostic.data as { configurations?: unknown } | undefined)?.configurations;
  if (!Array.isArray(entries)) return true;
  if (entries.length === 0) return false;
  if (imports.length === 0 || !libraryDoc) return true;
  return imports.some((imported) =>
    (entries as Assignment[]).some((entry) =>
      Object.entries(entry).every(([key, value]) => {
        const test = importFixes(libraryDoc, imported, key);
        return !test || test(value);
      }),
    ),
  );
}

/** What `imported` fixes the library's dimension `key` to, as a test of a
 *  dimension value; undefined when it leaves the dimension open. */
function importFixes(
  libraryDoc: ResourceManifest,
  imported: ImportDocument,
  key: string,
): ((value: unknown) => boolean) | undefined {
  const [block, name, member, ...rest] = key.split(".");
  if (!name || rest.length > 0) return undefined;
  if (block === "variables" || block === "secrets") {
    const declaration = recordAt(libraryDoc, block, name);
    if (!declaration) return undefined;
    const supplied = recordOf((imported as Record<string, unknown>)[block]);
    const value = supplied && Object.hasOwn(supplied, name) ? supplied[name] : declaration.default;
    if (value === undefined || !isLiteral(value)) return undefined;
    if (member !== undefined) {
      const held = memberOfValue(declaration, value, member);
      return held === undefined ? undefined : (v) => sameValue(v, held);
    }
    // A whole-value dimension holds the value (`null` its absence); a presence
    // dimension `present` / `absent`.
    return (v) =>
      sameValue(v, value) || (v === PRESENT && value !== null) || (v === ABSENT && value === null);
  }
  if (block === "resources" && member === undefined) {
    if (readResourceInputs(libraryDoc).some((input) => input.name === name && input.optional)) {
      const present = Object.hasOwn(readSuppliedResources(imported), name);
      return (v) => v === (present ? PRESENT : ABSENT);
    }
    if (readNeeds(libraryDoc).some((need) => need.name === name)) {
      const supplied = readSuppliedNeeds(imported);
      if (!Object.hasOwn(supplied, name) || needSupplyOf(supplied[name]).form !== "fields") return undefined;
      return (v) => v === PRESENT;
    }
  }
  return undefined;
}

/** The library's module document among its owner file's documents. */
export function libraryDocumentOf(graph: LoadedGraph, librarySource: string): ResourceManifest | undefined {
  return graph.modules.get(librarySource)?.owner.manifests.find((m) => m && isModuleKind(m.kind)) ?? undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordAt(doc: unknown, block: string, name: string): Record<string, unknown> | undefined {
  return recordOf(recordOf(recordOf(doc)?.[block])?.[name]);
}

/** A value with no expression, reference or expansion anywhere in it. */
function isLiteral(value: unknown): boolean {
  if (isTaggedSentinel(value) || isRefSentinel(value) || isExpansionSentinel(value) || isCompiledValue(value)) return false;
  if (Array.isArray(value)) return value.every(isLiteral);
  if (value && typeof value === "object") return Object.values(value).every(isLiteral);
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}
