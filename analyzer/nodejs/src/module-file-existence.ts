import { defaultRegistry, isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import type { HostEntryKind } from "@telorun/sdk";
import type { ImportEdge, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { nearestName } from "./nearest-name.js";
import { pathsAtOrBeneath, readAssetPatterns, stagedModuleFiles } from "./module-named-files.js";
import { readNativeEntries } from "./native-entries.js";
import { readModuleSources } from "./source-entries.js";
import { isNeverInstantiated } from "./validate-include-placement.js";
import { isOciRef } from "./sources/oci-ref.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type ManifestSource } from "./types.js";

/**
 * File-claim diagnostics for the entry and every module it reaches through a
 * filesystem-path import (`source: ./chat`), transitively.
 *
 * A registry import is skipped: its files were verified when it was published,
 * and its assets layer is fetched lazily, so asking the disk would be wrong. A
 * path import is never published on its own — this is the only point at which
 * anything checks its files before a resource embedding one is created.
 */
export async function collectLocalModuleFileDiagnostics(
  entry: LoadedModule,
  modules: ReadonlyMap<string, LoadedModule>,
  importEdges: ReadonlyMap<string, ReadonlyMap<string, ImportEdge>>,
  sourceFor: (url: string) => ManifestSource | undefined,
): Promise<AnalysisDiagnostic[]> {
  const out: AnalysisDiagnostic[] = [];
  const seen = new Set<string>([entry.owner.source]);
  const queue: LoadedModule[] = [entry];
  for (let next = queue.shift(); next; next = queue.shift()) {
    out.push(...(await collectModuleFileDiagnostics(next, sourceFor(next.owner.source))));
    for (const file of [next.owner, ...next.partials]) {
      for (const edge of importEdges.get(file.source)?.values() ?? []) {
        if (!isPathImport(edge.targetRef) || seen.has(edge.targetSource)) continue;
        seen.add(edge.targetSource);
        const target = modules.get(edge.targetSource);
        // A path import inside an artifact names a module shipped in it, whose
        // files are its layers — published, verified, and fetched lazily.
        if (target && !isOciRef(target.owner.requestedUrl)) queue.push(target);
      }
    }
  }
  return out;
}

/** The loader's own test for an import resolved against the importing file. */
function isPathImport(ref: string): boolean {
  return ref.startsWith(".") || ref.startsWith("/");
}

/**
 * The key the loader stamps on a tagged value whose one file claim names
 * something: what it found there, `file` or `directory` — what analysis holds
 * the value to where its slot says what the path must name
 * (`HOST_PATH_ENTRY_MISMATCH`). Absent when the source cannot answer.
 */
export const FOUND_ENTRY = "foundEntry";

/** What the loader found at a tagged value's one file claim, when it stamped it. */
export function foundEntryOf(value: unknown): HostEntryKind | undefined {
  if (!isTaggedSentinel(value)) return undefined;
  const found = (value as unknown as Record<string, unknown>)[FOUND_ENTRY];
  return found === "file" || found === "directory" ? found : undefined;
}

/** Every tagged value beneath `value`, with its dotted path. */
function walkSentinels(
  value: unknown,
  path: string,
  cb: (sentinel: TaggedSentinel, path: string) => void,
): void {
  if (isTaggedSentinel(value)) {
    cb(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkSentinels(v, `${path}[${i}]`, cb));
    return;
  }
  if (value !== null && typeof value === "object" && !(value as { __compiled?: unknown }).__compiled) {
    for (const [k, v] of Object.entries(value)) walkSentinels(v, path ? `${path}.${k}` : k, cb);
  }
}

/** What `relative` names among the files a module's `sources:` stages: one of
 *  them is a file, a path above one a directory. */
function stagedEntry(staged: readonly string[], relative: string): HostEntryKind | undefined {
  const beneath = pathsAtOrBeneath(staged, relative);
  if (beneath.length === 0) return undefined;
  return beneath.includes(relative.replace(/^\.\//, "")) ? "file" : "directory";
}

/**
 * One diagnostic for every tagged value in `module` whose file claim names
 * nothing — the static half of the kernel's refusal at resource creation. Each
 * engine declares its claims and the code reporting a missing one
 * (`TemplatingEngine.fileClaims`), so no tag is recognised here by name.
 *
 * What a claim names needs a filesystem, which the analyzer never touches, so
 * the question is put to the module's own `ManifestSource` (`entryAt`) — every
 * host that loads from disk answers it, and one that cannot (an in-browser
 * store) reports nothing rather than guessing. Well-formedness is the engine's
 * own diagnostic; a malformed path claims nothing. A value with exactly one
 * claim that names something is stamped with what it names ({@link FOUND_ENTRY}).
 *
 * A path a module file the module's own `sources:` block stages is present at
 * — a file when it is one, a directory when it sits above one: the kernel stages
 * it on first use, so a fresh checkout has no copy yet.
 */
export async function collectModuleFileDiagnostics(
  module: LoadedModule,
  source: ManifestSource | undefined,
): Promise<AnalysisDiagnostic[]> {
  if (!source?.entryAt) return [];
  const registry = defaultRegistry();
  const out: AnalysisDiagnostic[] = [];
  const ownerSource = module.owner.source;
  let staged: readonly string[] | undefined;
  for (const file of [module.owner, ...module.partials]) {
    const found: Array<{
      index: number;
      at: string;
      sentinel: TaggedSentinel;
      claims: number;
      relative: string;
      code: string;
    }> = [];
    file.manifests.forEach((manifest, index) => {
      // Never resolved there, so the engine's `*_OUTSIDE_RESOURCE` is the finding.
      if (!manifest || isNeverInstantiated(manifest.kind)) return;
      walkSentinels(manifest, "", (sentinel, at) => {
        const claims = registry.get(sentinel.engine)?.fileClaims?.(sentinel.source) ?? [];
        for (const claim of claims) {
          found.push({ index, at, sentinel, claims: claims.length, relative: claim.path, code: claim.notFoundCode });
        }
      });
    });
    for (const { index, at, sentinel, claims, relative, code } of found) {
      staged ??= stagedFilesOf(module.owner.manifests.find((m) => m && isModuleKind(m.kind)));
      // Module-root-relative: resolved against the OWNER, never the partial.
      const entry = stagedEntry(staged, relative) ?? (await source.entryAt(ownerSource, relative));
      if (entry !== undefined) {
        if (claims === 1) (sentinel as unknown as Record<string, unknown>)[FOUND_ENTRY] = entry;
        continue;
      }
      const written = sentinel.source;
      const engine = sentinel.engine;
      const manifest = file.manifests[index]!;
      const name = (manifest.metadata as { name?: string } | undefined)?.name;
      const range = file.positions[index]?.positionIndex?.get(at);
      const absolute = source.locate?.(ownerSource, relative);
      const hint = await nearMiss(source, ownerSource, relative, written);
      out.push({
        severity: DiagnosticSeverity.Error,
        code,
        source: "telo-analyzer",
        message:
          `${manifest.kind}${name ? `/${name}` : ""}: \`!${engine} ${written}\` ` +
          `names '${relative}', and there is nothing there${absolute ? ` (${absolute})` : ""}.` +
          (hint ? ` ${hint.text}` : "") +
          ` The path is relative to the module root — the directory holding telo.yaml. ` +
          `Create it or correct the path; if it exists in your checkout, whatever copied ` +
          `the module here left it out (an ignore file, a COPY step).`,
        data: {
          resource: { kind: manifest.kind, name: name ?? "" },
          filePath: file.source,
          path: at,
          ...(hint?.replacement ? { fix: { replacement: hint.replacement } } : {}),
        },
        ...(range ? { range } : {}),
      });
    }
  }
  return out;
}

/**
 * What the directory the claim points into says about it: that the directory
 * itself is missing, or the one entry a typo most plausibly meant — offered as
 * a fix replacing the path, kept in the author's `./` spelling. Nothing when
 * the source cannot list, or no entry is close enough to name.
 */
async function nearMiss(
  source: ManifestSource,
  ownerSource: string,
  relative: string,
  written: string,
): Promise<{ text: string; replacement?: string } | undefined> {
  if (!source.listDirectory) return undefined;
  const slash = relative.lastIndexOf("/");
  const directory = slash === -1 ? "" : relative.slice(0, slash);
  const entries = await source.listDirectory(ownerSource, directory || ".");
  if (!entries) return { text: `The directory '${directory}/' does not exist.` };
  const meant = nearestName(relative.slice(slash + 1), entries);
  if (!meant) return undefined;
  const path = directory ? `${directory}/${meant}` : meant;
  const replacement = written.trim().startsWith("./") ? `./${path}` : path;
  return { text: `Did you mean '${replacement}'?`, replacement };
}

/** None while the `sources:` block does not read, since the kernel then resolves nothing either. */
function stagedFilesOf(owner: unknown): string[] {
  const { sources, problems } = readModuleSources(owner);
  if (problems.length > 0) return [];
  return stagedModuleFiles(readNativeEntries(owner).entries, {
    patterns: readAssetPatterns(owner),
    sources,
  });
}
