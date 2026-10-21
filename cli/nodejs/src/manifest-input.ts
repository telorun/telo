import { resolveCacheRoot } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import { openPackagedApp, type PackagedApp } from "./package/app-unpack.js";

/**
 * What a command was handed in place of a manifest, resolved to what it loads.
 *
 * Every command that takes a manifest — `run`, `check`, `describe`, `needs
 * report`, `env template`, `cel functions` — resolves its argument here, so a
 * packaged executable is a manifest source to all of them alike: its payload is
 * unpacked into the directory a run of it would use, and the command loads that
 * tree's entry against the payload's own cache. The executable is recognised by
 * its trailer or segment and read as data; nothing it carries is executed.
 */
export interface ManifestInput {
  /** The manifest, directory or URL to load: the input resolved against the
   *  working directory, or the entry a packaged executable unpacked. */
  readonly entryPath: string;
  /** The `.telo` cache root the load reads, `null` for an entry with no local
   *  anchor. A packaged executable's is its payload — `TELO_CACHE_DIR` does not
   *  apply to it, since the payload is the only cache holding its modules. */
  readonly cacheRoot: string | null;
  /** Whether {@link cacheRoot} is SEALED: a packaged executable's payload,
   *  immutable and shared with every start of the binary. A sealed root is its
   *  input's only cache, loaded through a loader of its own, never revalidated
   *  against an origin, never pruned, and written to only by a run of the
   *  application; a module it does not hold is fetched as usual. */
  readonly cacheSealed: boolean;
  /** Set when the input is a packaged executable. */
  readonly packaged?: PackagedInput;
}

export interface PackagedInput extends PackagedApp {
  /** Where the application's env files are read from — and its `--debug` log
   *  written: the working directory, since the entry sits at a digest-keyed path
   *  no operator should have to find. */
  readonly envAnchor: string;
}

export interface ManifestInputOptions {
  /** Reclaim the application's other unpacked trees — a run's privilege alone. */
  readonly reclaim?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function resolveEntryPath(inputPath: string): string {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  return isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
}

export async function resolveManifestInput(
  input: string,
  options: ManifestInputOptions = {},
): Promise<ManifestInput> {
  const entryPath = resolveEntryPath(input);
  const executable = URL_SCHEME.test(input) ? undefined : regularFile(entryPath);
  const app = executable
    ? await openPackagedApp(executable, { reclaim: options.reclaim === true, env: options.env })
    : undefined;
  if (!app) return { entryPath, cacheRoot: resolveCacheRoot(entryPath), cacheSealed: false };
  return {
    entryPath: app.entry,
    cacheRoot: app.cacheDir,
    cacheSealed: true,
    packaged: { ...app, envAnchor: process.cwd() },
  };
}

/** `file` when it names a regular file; a directory or a missing path is the
 *  loader's to answer. */
function regularFile(file: string): string | undefined {
  try {
    return fs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}
