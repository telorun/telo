import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  PLATFORM_AXES,
  describeSelector,
  selectorMatches,
  type ModuleSources,
  type NativeEntries,
  type NativeEntry,
  type PlatformTarget,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { checkStagedEntry } from "./bundle/staged-entry.js";
import { hostPlatformTarget, type ModuleArtifact } from "./bundle/module-artifact.js";

/** The slice of the kernel this module needs: a module's artifact, when it has
 *  one. A module already on disk has none — that is normal, not an error. */
export interface ModuleArtifactLookup {
  getModuleArtifact(source: string | undefined): ModuleArtifact | undefined;
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
 * Shared by `ctx.resolveModuleFile` and by `!include-*` resolution, so a file
 * reached by a controller and a file embedded by a tag are located by one rule
 * — including which layers get materialized on the way.
 */
export async function resolveModuleFileUri(
  relative: string,
  source: string,
  lookup: ModuleArtifactLookup,
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
  return new URL(relative, base).href;
}

/** The two module-doc blocks a native file is resolved from. */
export interface NativeFileModule {
  /** Canonical source of the module's `telo.yaml` — what its artifact is keyed by. */
  readonly source: string;
  readonly native: NativeEntries;
  readonly sources: ModuleSources;
}

/**
 * Resolve a native file by its logical name to a `file://` URI, against the
 * module that declares it.
 *
 * The first `native:` entry of that name, in declaration order, whose selector
 * matches `host` wins (spec §2.4). From a published artifact, that entry's
 * `native` layer alone is materialized, verified before extraction. From a
 * source checkout the file is read where the entry names it: verified against its
 * pin when a `sources:` entry stages it, as it is when none does. Nothing here
 * fetches a staged file — that is `telo release stage`'s, so a developer run
 * never depends on an upstream being reachable.
 */
export async function resolveNativeFileUri(
  name: string,
  module: NativeFileModule,
  lookup: ModuleArtifactLookup,
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
  await assertSourceCheckoutFile(dir, entry, module.sources, unavailable);
  return pathToFileURL(path.join(dir, entry.path)).href;
}

async function assertSourceCheckoutFile(
  dir: string,
  entry: NativeEntry,
  sources: ModuleSources,
  unavailable: (cause: string) => RuntimeError,
): Promise<void> {
  for (const source of sources.sources) {
    const staged = source.entries.find((candidate) => candidate.path === entry.path);
    if (!staged) continue;
    const verdict = await checkStagedEntry(dir, source, staged);
    const by = `'${entry.path}' (${entry.origin}) is staged by source '${source.name}'`;
    switch (verdict.state) {
      case "match":
        return;
      case "unpinned":
        throw unavailable(
          `${by}, which carries no pin to verify it against — run \`telo release stage --pin\`.`,
        );
      case "missing":
        throw unavailable(
          `${by}, but ${verdict.detail} — run \`telo release stage\` to fetch it. A staged file ` +
            `is never fetched at run time.`,
        );
      case "mismatch":
        throw unavailable(
          `${by}, but ${verdict.detail} — run \`telo release stage\` to restage it.`,
        );
    }
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
        `it. Check the file in, or declare the archive it comes from under sources: and run ` +
        `\`telo release stage\`.`,
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
