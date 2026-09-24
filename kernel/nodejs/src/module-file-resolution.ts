import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  PLATFORM_AXES,
  describeSelector,
  selectorMatches,
  pathsAtOrBeneath,
  stagedModuleFiles,
  type ModuleSource,
  type ModuleSources,
  type NativeEntries,
  type NativeEntry,
  type PlatformTarget,
  type SourceEntry,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import {
  createArchiveReader,
  describeStagingFailure,
  type ArchiveReader,
  type EnsuredEntryState,
} from "./bundle/source-staging.js";
import { hostPlatformTarget, type ModuleArtifact } from "./bundle/module-artifact.js";

/** The slice of the kernel this module needs: a module's artifact, when it has
 *  one. A module already on disk has none — that is normal, not an error. */
export interface ModuleArtifactLookup {
  getModuleArtifact(source: string | undefined): ModuleArtifact | undefined;
}

/** Module-file resolution also needs the module a file belongs to, for the
 *  `sources:` block that may stage it. */
export interface ModuleFileLookup extends ModuleArtifactLookup {
  /** The module one of whose files resolved from `source`, or `undefined` for a
   *  module this load did not read. */
  getDeclaringModule(source: string | undefined): NativeFileModule | undefined;
  /** Bring a staged entry to its pin, fetching it when it is missing or stale —
   *  memoized by the kernel, so a file already matching is not hashed again on
   *  every resolution. Throws when staging fails. */
  ensureStagedEntry(
    dir: string,
    source: ModuleSource,
    entry: SourceEntry,
    archives?: ArchiveReader,
  ): Promise<EnsuredEntryState>;
}

/**
 * Resolve a module-relative reference against the declaring module's own
 * directory, materializing the layers that could carry it on first use.
 *
 * A URI, not a filesystem path: the SDK is cross-runtime, and a path is only
 * what *this* kernel happens to return for a module whose files are local. An
 * already-absolute URI (one with a scheme) passes through untouched; a bare
 * absolute filesystem path is returned as a `file://` URI rather than being
 * rebased onto the module directory.
 *
 * In a source checkout, every module file a `sources:` entry stages at or beneath
 * the reference — one an `assets:` pattern selects, or a notice — is staged when
 * missing or stale and verified against its pin before the URI is returned: the
 * rule native files follow, applied to a path that may name a directory. A
 * native file or a prebuilt controller is staged by its own resolution, for this
 * host alone, so a directory reference never fetches every platform's archive.
 *
 * Shared by `ctx.resolveModuleFile`, `ctx.resolveControllerFile` and
 * `!include-*` resolution, so a file reached by a controller and a file embedded
 * by a tag are located by one rule — including which layers get materialized on
 * the way.
 */
export async function resolveModuleFileUri(
  relative: string,
  source: string,
  lookup: ModuleFileLookup,
): Promise<string> {
  // An absolute URI names its own location; a bare absolute path is already
  // resolved and must not be rebased onto the module directory.
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return relative;
  if (path.isAbsolute(relative)) return pathToFileURL(relative).href;

  const artifact = lookup.getModuleArtifact(source);
  if (artifact) {
    // Both the `assets` layer and `common` — the sink rule puts a file the
    // author did not claim via `assets:` into `common`, and a module that ships
    // static files with no bundled controller has no other route to its payload.
    // Fetching only assets would leave such a module resolving into an empty
    // directory.
    await artifact.materializeModuleFiles();
    return new URL(relative, pathToFileURL(path.join(artifact.directory, "/")).href).href;
  }
  // No artifact means no payload to fetch. That is normal for a module already
  // on disk (development) or one that ships no files — but for a module reached
  // over a non-local scheme it means the artifact carries no layer index, i.e. it
  // predates layers. Raise the actionable error here rather than leaving each
  // caller to invent its own message from a URI it cannot open.
  if (!isLocalSource(source)) {
    throw new RuntimeError(
      "ERR_MODULE_FILES_UNAVAILABLE",
      `Cannot resolve '${relative}' against module '${source}': the module's artifact ` +
        `carries no layer index, so its files cannot be located. It was published by an ` +
        `older Telo that wrote a single-blob artifact — republish the module, or import it ` +
        `from a local path during development.`,
    );
  }
  // Local module: resolve against the manifest URL, the same rule `include:`
  // and sibling imports follow.
  const base = source.startsWith("file://") ? source : pathToFileURL(source).href;
  const uri = new URL(relative, base).href;
  const module = lookup.getDeclaringModule(source);
  if (module) await assertStagedFilesAt(uri, module, lookup);
  return uri;
}

/**
 * Stage an entry and say why it still cannot be handed over, or `undefined` when
 * it matches its pin. A failure to stage is part of the answer, not a separate
 * throw, so every caller reports it under its own error code.
 */
async function stagedEntryProblem(
  by: string,
  stage: () => Promise<EnsuredEntryState>,
): Promise<string | undefined> {
  let verdict: EnsuredEntryState;
  try {
    verdict = await stage();
  } catch (err) {
    return `${by}, ${describeStagingFailure(err)}`;
  }
  return verdict.state === "unpinned"
    ? `${by}, which carries no pin to verify it against — run \`telo release stage --pin\`.`
    : undefined;
}

/**
 * Refuse a checkout reference under which a `sources:` entry stages a module file
 * that is unpinned or cannot be staged. An entry is covered when its path is the
 * reference or runs through it as a directory.
 */
async function assertStagedFilesAt(
  uri: string,
  module: NativeFileModule,
  lookup: ModuleFileLookup,
): Promise<void> {
  const dir = path.dirname(
    module.source.startsWith("file://") ? fileURLToPath(module.source) : module.source,
  );
  const relative = path.relative(dir, fileURLToPath(uri)).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  const unavailable = (cause: string) =>
    new RuntimeError(
      "ERR_MODULE_FILES_UNAVAILABLE",
      `Cannot resolve '${relative === "" ? "./" : relative}' against module '${module.source}': ${cause}`,
    );
  if (module.sources.problems.length > 0) {
    throw unavailable(
      `the module's sources: block cannot be read, so which of its files are staged — and what ` +
        `they must hash to — is unknown:\n` +
        module.sources.problems.map((problem) => `  ${problem.message}`).join("\n") +
        `\nRun \`telo check\` on the module.`,
    );
  }
  // The analyzer's rule, which `telo check` and release planning read too.
  const moduleFiles = stagedModuleFiles(module.native.entries, {
    patterns: module.assetPatterns,
    sources: module.sources.sources,
  });
  const covered = new Set(relative === "" ? moduleFiles : pathsAtOrBeneath(moduleFiles, relative));
  let archives: ArchiveReader | undefined;
  for (const source of module.sources.sources) {
    for (const entry of source.entries) {
      if (!covered.has(entry.path)) continue;
      archives ??= createArchiveReader();
      const reader = archives;
      const problem = await stagedEntryProblem(`'${entry.path}' is staged by source '${source.name}'`, () =>
        lookup.ensureStagedEntry(dir, source, entry, reader),
      );
      if (problem) throw unavailable(problem);
    }
  }
}

/** The module-doc blocks a native or module file is resolved from. */
export interface NativeFileModule {
  /** Canonical source of the module's `telo.yaml` — what its artifact is keyed by. */
  readonly source: string;
  readonly native: NativeEntries;
  readonly sources: ModuleSources;
  /** The `assets:` patterns, which say which staged entries are module files. */
  readonly assetPatterns: readonly string[];
}

/**
 * Resolve a native file by its logical name to a `file://` URI, against the
 * module that declares it.
 *
 * The first `native:` entry of that name, in declaration order, whose selector
 * matches `host` wins (spec §2.4). From a published artifact, that entry's
 * `native` layer alone is materialized, verified before extraction. From a
 * source checkout the file is read where the entry names it: staged on first use
 * and verified against its pin when a `sources:` entry stages it, read as it is
 * when none does.
 */
export async function resolveNativeFileUri(
  name: string,
  module: NativeFileModule,
  lookup: ModuleFileLookup,
  host: PlatformTarget = hostPlatformTarget(),
): Promise<string> {
  const unavailable = (cause: string) =>
    new RuntimeError(
      "ERR_NATIVE_FILE_UNAVAILABLE",
      `Cannot resolve native file '${name}' of module '${module.source}': ${cause}` +
        unreadableEntries(module.native),
    );

  const named = module.native.entries.filter((entry) => entry.name === name);
  if (named.length === 0) {
    const declared = [...new Set(module.native.entries.map((entry) => entry.name))];
    throw unavailable(
      declared.length === 0
        ? `the module declares no native files.`
        : `the module declares no native file of that name (it declares ${declared
            .map((n) => `'${n}'`)
            .join(", ")}).`,
    );
  }
  const entry = named.find((candidate) => selectorMatches(candidate.selector, host));
  if (!entry) {
    throw unavailable(
      `no entry matches this host (${describeHost(host)}). The module ships it for: ` +
        `${named.map((candidate) => describeSelector(candidate.selector)).join("; ")}. ` +
        `A host outside that set needs a release of the module that ships a native layer for it.`,
    );
  }

  const artifact = lookup.getModuleArtifact(module.source);
  if (artifact) {
    const layer = await artifact.materializeNative(entry.selector);
    if (!layer || !layer.files.includes(entry.path)) {
      throw unavailable(
        `${entry.origin} for ${describeSelector(entry.selector)} matches this host, but the ` +
          `module's artifact ${layer ? `has no '${entry.path}' in its native layer for that selector` : "ships no native layer for that selector"} — ` +
          `the module has to be republished.`,
      );
    }
    return pathToFileURL(path.join(artifact.directory, entry.path)).href;
  }
  if (!isLocalSource(module.source)) {
    throw unavailable(
      `the module's artifact carries no layer index, so its native files cannot be located. ` +
        `It was published by an older Telo that wrote a single-blob artifact — republish the ` +
        `module, or import it from a local path during development.`,
    );
  }

  const dir = path.dirname(
    module.source.startsWith("file://") ? fileURLToPath(module.source) : module.source,
  );
  await assertSourceCheckoutFile(dir, entry, module.sources, lookup, unavailable);
  return pathToFileURL(path.join(dir, entry.path)).href;
}

async function assertSourceCheckoutFile(
  dir: string,
  entry: NativeEntry,
  sources: ModuleSources,
  lookup: ModuleFileLookup,
  unavailable: (cause: string) => RuntimeError,
): Promise<void> {
  for (const source of sources.sources) {
    const staged = source.entries.find((candidate) => candidate.path === entry.path);
    if (!staged) continue;
    const problem = await stagedEntryProblem(
      `'${entry.path}' (${entry.origin}) is staged by source '${source.name}'`,
      () => lookup.ensureStagedEntry(dir, source, staged),
    );
    if (problem) throw unavailable(problem);
    return;
  }
  // No readable source stages it. A block that could not be read might be the
  // one that does, so the file is not read unverified.
  if (sources.problems.length > 0) {
    throw unavailable(
      `the module's sources: block cannot be read, so whether '${entry.path}' is staged — and ` +
        `what it must hash to — is unknown:\n` +
        sources.problems.map((problem) => `  ${problem.message}`).join("\n") +
        `\nRun \`telo check\` on the module.`,
    );
  }
  const abs = path.join(dir, entry.path);
  const missing = (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ELOOP") return undefined;
    throw err;
  };
  const stat = await fs.lstat(abs).catch(missing);
  if (stat?.isSymbolicLink()) {
    // A checked-in link is read only where publish would ship it: inside the
    // module, ending at a regular file.
    const [real, root] = await Promise.all([fs.realpath(abs).catch(missing), fs.realpath(dir)]);
    const relative = real === undefined ? undefined : path.relative(root, real);
    if (relative === undefined || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw unavailable(
        `'${entry.path}' (${entry.origin}) is a symbolic link that ` +
          `${real === undefined ? "leads to no file" : `leads outside the module directory, to '${real}'`}. ` +
          `A native file ships inside its module — point the link at a file in the module, or ` +
          `declare it as a sources: link entry.`,
      );
    }
    if (!(await fs.stat(real!)).isFile()) {
      throw unavailable(`'${entry.path}' (${entry.origin}) is a symbolic link to '${relative}', which is not a file.`);
    }
    return;
  }
  if (!stat?.isFile()) {
    throw unavailable(
      `'${entry.path}' (${entry.origin}) is not a file on disk, and no sources: entry stages ` +
        `it. Check the file in, or declare the archive it comes from under sources: and pin it ` +
        `with \`telo release stage --pin\`.`,
    );
  }
}

function isLocalSource(source: string): boolean {
  return source.startsWith("file://") || path.isAbsolute(source);
}

/** `os=linux, arch=amd64, libc=gnu, abi=undetermined` — every axis, an absent one named. */
function describeHost(host: PlatformTarget): string {
  return PLATFORM_AXES.map((axis) => `${axis}=${host[axis] ?? "undetermined"}`).join(", ");
}

function unreadableEntries(native: NativeEntries): string {
  if (native.problems.length === 0) return "";
  return (
    `\nThe module's native: block also has entries that cannot be read, which resolution ` +
    `skipped:\n${native.problems.map((problem) => `  ${problem.message}`).join("\n")}`
  );
}
