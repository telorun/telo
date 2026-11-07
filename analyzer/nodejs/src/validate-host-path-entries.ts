import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import {
  describeHostEntry,
  hostEntryAt,
  hostMediaTypeAt,
  hostMediaTypeFinding,
  hostMediaTypeMismatchAt,
} from "./host-path-slot.js";
import { foundEntryOf, foundHeadOf } from "./module-file-existence.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

interface FoundModuleFile {
  path: string;
  source: string;
  engine: string;
  found: "file" | "directory";
  head: Uint8Array | undefined;
}

/** Every tagged value beneath `value` with what the loader found at its file
 *  claim, and its dotted path. */
function foundEntries(value: unknown, path: string, out: FoundModuleFile[]): void {
  if (isTaggedSentinel(value)) {
    const found = foundEntryOf(value);
    if (found) out.push({ path, source: value.source, engine: value.engine, found, head: foundHeadOf(value) });
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
 * entry there — `HOST_PATH_ENTRY_MISMATCH` — or a file whose leading bytes do
 * not carry the media type the slot declares — `HOST_PATH_CONTENT_MISMATCH`.
 * The loader stamps what each claim names (`foundEntry`) and a file's head
 * (`foundHead`); a source that cannot answer stamps nothing, and the kernel
 * refuses the same mistake when it creates the resource.
 */
export function moduleFileEntryMismatches(
  manifest: ResourceManifest,
  slotAt: (path: string) => Record<string, any> | undefined,
): AnalysisDiagnostic[] {
  const found: FoundModuleFile[] = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "kind" || key === "metadata") continue;
    foundEntries(value, key, found);
  }
  const resource = { kind: manifest.kind, name: (manifest.metadata?.name as string | undefined) ?? "" };
  const filePath = (manifest.metadata as { source?: string } | undefined)?.source;
  const out: AnalysisDiagnostic[] = [];
  for (const site of found) {
    const slot = slotAt(site.path);
    const wanted = hostEntryAt(slot);
    if (wanted !== undefined && wanted !== site.found) {
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "HOST_PATH_ENTRY_MISMATCH",
        source: SOURCE,
        message:
          `${resource.kind}/${resource.name}: '${site.path}' takes the path of ${describeHostEntry(wanted)}, ` +
          `but \`!${site.engine} ${site.source}\` names ${describeHostEntry(site.found)}.`,
        data: { resource, filePath, path: site.path },
      });
      continue;
    }
    const declared = hostMediaTypeAt(slot);
    if (declared === undefined) continue;
    const mismatch =
      site.found === "directory"
        ? ("directory" as const)
        : site.head
          ? hostMediaTypeMismatchAt(slot, site.head)
          : undefined;
    if (!mismatch) continue;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "HOST_PATH_CONTENT_MISMATCH",
      source: SOURCE,
      message:
        `${resource.kind}/${resource.name}: ` +
        hostMediaTypeFinding(
          `${site.path}: '${site.source.trim()}'`,
          mismatch === "directory" ? mismatch : { mediaType: mismatch.found },
          declared,
        ) +
        ".",
      data: { resource, filePath, path: site.path },
    });
  }
  return out;
}
