import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { describeHostEntry, hostEntryAt } from "./host-path-slot.js";
import { foundEntryOf } from "./module-file-existence.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Every tagged value beneath `value` with what the loader found at its file
 *  claim, and its dotted path. */
function foundEntries(
  value: unknown,
  path: string,
  out: Array<{ path: string; source: string; engine: string; found: "file" | "directory" }>,
): void {
  if (isTaggedSentinel(value)) {
    const found = foundEntryOf(value);
    if (found) out.push({ path, source: value.source, engine: value.engine, found });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => foundEntries(item, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      foundEntries(child, path ? `${path}.${key}` : key, out);
    }
  }
}

/**
 * A module file a resource names (`!module-path ./public`) at a host-path slot
 * that says what its path must name, where the loader found the other kind of
 * entry there — `HOST_PATH_ENTRY_MISMATCH`. The loader stamps what each claim
 * names (`foundEntry`); a source that cannot answer stamps nothing, and the
 * kernel refuses the same mistake when it creates the resource.
 */
export function moduleFileEntryMismatches(
  manifest: ResourceManifest,
  slotAt: (path: string) => Record<string, any> | undefined,
): AnalysisDiagnostic[] {
  const found: Array<{ path: string; source: string; engine: string; found: "file" | "directory" }> = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "kind" || key === "metadata") continue;
    foundEntries(value, key, found);
  }
  const resource = { kind: manifest.kind, name: (manifest.metadata?.name as string | undefined) ?? "" };
  const filePath = (manifest.metadata as { source?: string } | undefined)?.source;
  const out: AnalysisDiagnostic[] = [];
  for (const site of found) {
    const wanted = hostEntryAt(slotAt(site.path));
    if (wanted === undefined || wanted === site.found) continue;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_ENTRY_MISMATCH",
      source: SOURCE,
      message:
        `${resource.kind}/${resource.name}: '${site.path}' takes the path of ${describeHostEntry(wanted)}, ` +
        `but \`!${site.engine} ${site.source}\` names ${describeHostEntry(site.found)}.`,
      data: { resource, filePath, path: site.path },
    });
  }
  return out;
}
