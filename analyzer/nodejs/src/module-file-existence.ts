import { defaultRegistry, isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { HOST_MEDIA_HEAD_LENGTH, type HostEntryKind } from "@telorun/sdk";
import type { ImportEdge, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { nearestName } from "./nearest-name.js";
import { readNeeds } from "./need-type.js";
import { pathsAtOrBeneath, readAssetPatterns, stagedModuleFiles } from "./module-named-files.js";
import { readNativeEntries } from "./native-entries.js";
import { readModuleSources } from "./source-entries.js";
import { isNeverInstantiated } from "./validate-include-placement.js";
import { httpManifestUrl } from "./sources/http-source.js";
import { isOciRef } from "./sources/oci-ref.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type ManifestSource } from "./types.js";

/**
 * File-claim diagnostics for the entry and every module it reaches through a
 * filesystem-path import (`source: ./chat`) or an `http(s)://` import,
 * transitively.
 *
 * A registry import is skipped: its files were verified when it was published,
 * and its assets layer is fetched lazily, so asking the disk would be wrong. A
 * path import is never published on its own — this is the only point at which
 * anything checks its files before a resource embedding one is created. A module
 * read over HTTP has no publish step either, so its files are asked of its
 * origin, even when the manifest itself was served from a cached copy.
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
    const remote = httpManifestUrl(next.owner.requestedUrl);
    out.push(
      ...(await collectModuleFileDiagnostics(
        next,
        sourceFor(remote ?? next.owner.source),
        remote ?? next.owner.source,
      )),
    );
    for (const file of [next.owner, ...next.partials]) {
      for (const edge of importEdges.get(file.source)?.values() ?? []) {
        if (seen.has(edge.targetSource)) continue;
        const target = modules.get(edge.targetSource);
        if (!target) continue;
        // A path import inside an artifact names a module shipped in it, whose
        // files are its layers — published, verified, and fetched lazily.
        const local = isPathImport(edge.targetRef) && !isOciRef(target.owner.requestedUrl);
        if (!local && httpManifestUrl(target.owner.requestedUrl) === undefined) continue;
        seen.add(edge.targetSource);
        queue.push(target);
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

/**
 * The key the loader stamps beside {@link FOUND_ENTRY} on a tagged value whose
 * one file claim names a file, when its source can read it: the file's leading
 * bytes as lower-case hex, as many as decide every media type
 * (`HOST_MEDIA_HEAD_LENGTH`) — what analysis holds the value to where its slot
 * says what media type the file holds (`HOST_PATH_CONTENT_MISMATCH`).
 */
export const FOUND_HEAD = "foundHead";

/** The leading bytes the loader read at a tagged value's one file claim, when it stamped them. */
export function foundHeadOf(value: unknown): Uint8Array | undefined {
  if (!isTaggedSentinel(value)) return undefined;
  const hex = (value as unknown as Record<string, unknown>)[FOUND_HEAD];
  if (typeof hex !== "string") return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
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
 * claim that names something is stamped with what it names ({@link FOUND_ENTRY})
 * and, for a file its source can read, with its leading bytes ({@link FOUND_HEAD}).
 *
 * A path a module file the module's own `sources:` block stages is present at
 * — a file when it is one, a directory when it sits above one: the kernel stages
 * it on first use, so a fresh checkout has no copy yet.
 */
export async function collectModuleFileDiagnostics(
  module: LoadedModule,
  source: ManifestSource | undefined,
  base: string = module.owner.source,
): Promise<AnalysisDiagnostic[]> {
  if (!source?.entryAt) return [];
  const registry = defaultRegistry();
  const out: AnalysisDiagnostic[] = [];
  let staged: readonly string[] | undefined;
  for (const file of [module.owner, ...module.partials]) {
    const found: Array<{
      index: number;
      at: string;
      sentinel: TaggedSentinel;
      claims: number;
      relative: string;
      code: string;
      directory: boolean;
    }> = [];
    file.manifests.forEach((manifest, index) => {
      if (!manifest) return;
      const collect = (sentinel: TaggedSentinel, at: string) => {
        const claims = registry.get(sentinel.engine)?.fileClaims?.(sentinel.source) ?? [];
        for (const claim of claims) {
          found.push({
            index,
            at,
            sentinel,
            claims: claims.length,
            relative: claim.path,
            code: claim.notFoundCode,
            directory: claim.directory === true,
          });
        }
      };
      // A module document's needs' `parameters:` are resolved at load; nothing
      // else in a document never instantiated is resolved, so the engine's
      // `*_OUTSIDE_RESOURCE` is the finding there.
      if (isModuleKind(manifest.kind)) {
        for (const need of readNeeds(manifest)) {
          walkSentinels(need.parameters, `needs.${need.name}.parameters`, collect);
        }
        return;
      }
      if (isNeverInstantiated(manifest.kind)) return;
      walkSentinels(manifest, "", collect);
    });
    for (const { index, at, sentinel, claims, relative, code, directory } of found) {
      staged ??= stagedFilesOf(module.owner.manifests.find((m) => m && isModuleKind(m.kind)));
      // Module-root-relative: resolved against the OWNER, never the partial.
      const written = sentinel.source;
      const engine = sentinel.engine;
      const manifest = file.manifests[index]!;
      const name = (manifest.metadata as { name?: string } | undefined)?.name;
      const range = file.positions[index]?.positionIndex?.get(at);
      const absolute = source.locate?.(base, relative);
      const remote = absolute !== undefined && /^https?:\/\//.test(absolute);
      let entry: HostEntryKind | undefined;
      let head: Uint8Array | undefined;
      try {
        entry = stagedEntry(staged, relative) ?? (await source.entryAt(base, relative));
        if (entry === "file" && claims === 1 && HOST_MEDIA_HEAD_LENGTH > 0) {
          head = await source.readHead?.(base, relative, HOST_MEDIA_HEAD_LENGTH);
        }
      } catch (error) {
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "MODULE_FILE_UNREADABLE",
          source: "telo-analyzer",
          message:
            `${manifest.kind}${name ? `/${name}` : ""}: \`!${engine} ${written}\` names '${relative}', ` +
            `and checking it failed${absolute ? ` (${absolute})` : ""}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          data: {
            resource: { kind: manifest.kind, name: name ?? "" },
            filePath: file.source,
            path: at,
          },
          ...(range ? { range } : {}),
        });
        continue;
      }
      if (entry !== undefined) {
        if (claims === 1) {
          const stamped = sentinel as unknown as Record<string, unknown>;
          stamped[FOUND_ENTRY] = entry;
          if (head) stamped[FOUND_HEAD] = Array.from(head, (b) => b.toString(16).padStart(2, "0")).join("");
        }
        continue;
      }
      const hint = await nearMiss(source, base, relative, written);
      // A URL cannot be listed, so a claim that may name a directory cannot be told
      // from a missing file there: it is advice, and the runtime still refuses it.
      const unverifiable = remote && directory;
      out.push({
        severity: unverifiable ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
        code,
        source: "telo-analyzer",
        message:
          `${manifest.kind}${name ? `/${name}` : ""}: \`!${engine} ${written}\` ` +
          `names '${relative}', and there is nothing there${absolute ? ` (${absolute})` : ""}.` +
          (hint ? ` ${hint.text}` : "") +
          ` The path is relative to the module root — the directory holding telo.yaml. ` +
          (remote
            ? `A module read over a URL ships the files it names one by one — a directory ` +
              `cannot be listed${unverifiable ? `, so this cannot be told from a missing file and will not be fetched` : ""}; ` +
              `claim the files inside it individually. `
            : "") +
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
