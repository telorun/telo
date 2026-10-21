/**
 * How a static-analysis command loads a manifest graph: one loader per
 * invocation, the manifest cache ahead of the transports, and every mutable
 * `oci://` tag revalidated before a verdict is computed from it — except in a
 * packaged executable's sealed payload, read alone and as it is. `telo check` and
 * `telo cel functions <manifest>` both load through here, so a listing reads the
 * same bytes a check judges.
 */
import { Loader, type LoadedGraph } from "@telorun/analyzer";
import { LocalManifestCacheSource, resolveEntryDir } from "@telorun/kernel";
import { LocalFileSource } from "@telorun/kernel/manifest-sources/local-file-source";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import type { Logger } from "./logger.js";
import type { ManifestInput } from "./manifest-input.js";
import {
  RecordingCacheSource,
  readOriginDigests,
  revalidateMutableOciRefs,
} from "./manifest-freshness.js";
import { outErrLine } from "./output.js";

/** Where one input path's manifest cache lives. `null` for an HTTP(S) entry,
 *  which has no local anchor to hang a `.telo` directory off. */
export interface CacheTarget {
  entryDir: string;
  manifestsDir: string;
  /** A packaged executable's payload ({@link ManifestInput.cacheSealed}). */
  sealed: boolean;
}

export function cacheTargetFor(input: ManifestInput): CacheTarget | null {
  const entryDir = resolveEntryDir(input.entryPath);
  if (!input.cacheRoot || entryDir === null) return null;
  return {
    entryDir,
    manifestsDir: path.join(input.cacheRoot, "manifests"),
    sealed: input.cacheSealed,
  };
}

export interface CheckSession {
  /** Opened over a sealed root: nothing it serves is revalidated or dropped. */
  sealed: boolean;
  loader: Loader;
  /** One recorder per distinct cache root, so the freshness pass can tell which
   *  manifests were served from disk and from which file. */
  recorders: RecordingCacheSource[];
  /** The `manifests` dir of every registered root, in the same order — the
   *  freshness pass judges a cached file against the record of the root it came
   *  from, which need not be the one this entry writes to. */
  manifestsDirs: string[];
  /** Mutable tags already probed in this invocation. Shared across input paths
   *  so a module imported by twenty manifests is `HEAD`ed once, not per file. */
  verified: Map<string, string>;
}

/**
 * One loader for the whole invocation, ahead of the transports:
 *
 *  - `LocalManifestCacheSource` makes a repeat check hermetic. Without it every
 *    `oci://` import was re-pulled on every run even when fully pinned, which
 *    is the bulk of `check`'s wall time.
 *  - The loader is shared across *all* input paths, so `telo check a b c` reads
 *    a module common to several of them once. Its `urlToSource` / `fileCache`
 *    dedupe by canonical URL, so this is purely a cache-hit question — the
 *    resolution result for a given URL does not depend on which entry asked.
 *
 * A cache source is registered for every input path's cache root: the entries
 * are content-addressed, so a hit under any root is as good as a hit under the
 * one this path would write to, and a miss falls through unchanged.
 *
 * A sealed root is the exception, and gets a session of its own: it is the only
 * cache of its input and serves no other, so it is never passed in beside
 * another target.
 */
export function openSession(cacheTargets: CacheTarget[]): CheckSession {
  const sealed = cacheTargets.find((t) => t.sealed);
  if (sealed) {
    if (cacheTargets.length !== 1) {
      throw new Error(
        `the sealed cache root ${sealed.manifestsDir} must be the only cache of its session`,
      );
    }
    return openSealedSession(sealed);
  }
  const recorders = cacheTargets.map(
    (t) => new RecordingCacheSource(new LocalManifestCacheSource(t.entryDir, t.manifestsDir)),
  );
  // The kernel's transport sources — the same set `install` / `run` use — so
  // `check` resolves every scheme they do, `oci://` included, direct-to-origin.
  // The browser-only `manifests.telo.sh` cache path stays the editor's; a CLI
  // resolves origin-direct so it never depends on the hub — resolution never
  // routes through it.
  const loader = new Loader([
    new LocalFileSource(),
    ...recorders,
    ...defaultTransportRegistry().sources(),
  ]);
  return {
    sealed: false,
    loader,
    recorders,
    manifestsDirs: cacheTargets.map((t) => t.manifestsDir),
    verified: new Map(),
  };
}

/**
 * A packaged executable's payload as its input's only cache. The payload is
 * immutable and every start of the binary unpacks into the same tree, so what
 * it holds is the build's answer, not a copy that can go stale: it is served for
 * every scheme the cache maps, with no recorder, so no tag is revalidated, no
 * request is made for a module it holds and nothing is removed from it. A module
 * it does not hold falls through to the transports.
 */
function openSealedSession(target: CacheTarget): CheckSession {
  const loader = new Loader([
    new LocalFileSource(),
    new LocalManifestCacheSource(target.entryDir, target.manifestsDir),
    ...defaultTransportRegistry().sources(),
  ]);
  return { sealed: true, loader, recorders: [], manifestsDirs: [], verified: new Map() };
}

/**
 * Drop a stale cache entry: the file, the loader's memo of it, and the record
 * that it was ever served. The next load re-resolves that one manifest through
 * the transports and leaves every other file's memo intact.
 *
 * Removal failures are warned, not thrown. This is cache maintenance, and the
 * rest of the command already treats caching as an optimization — a read-only
 * or root-owned `.telo` must not change the exit code of a static check. An
 * entry that could not be removed is still forgotten by the loader, so the
 * reload re-fetches it rather than trusting bytes it just judged stale.
 */
async function dropStaleEntry(file: string, session: CheckSession, log: Logger): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    outErrLine(
      `${log.err.warn(
        `[manifest-cache] could not remove stale entry ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )}\n`,
    );
  }
  session.loader.forget(pathToFileURL(file).href);
  for (const recorder of session.recorders) {
    for (const [url, served] of recorder.served) {
      if (served === file) recorder.served.delete(url);
    }
  }
}

/**
 * The graph of `entryPath`, loaded through `session` and never from a moved tag.
 *
 * Freshness is judged before anything is computed from the graph: a mutable tag
 * that moved under the cache has its entries dropped — file, loader memo and
 * served record, so every other path's resolution survives — and the graph is
 * loaded again. Revalidation is off for that reload: the digests were
 * established a moment ago, and the reload cannot be stale because the entries
 * it would have used are gone. Pinned imports make the whole pass a no-op, and
 * so does a sealed session, whose cache is the payload's own answer.
 *
 * Returns the digests observed, which a cache write records against what the
 * origin serves now.
 */
export async function loadFreshGraph(
  entryPath: string,
  session: CheckSession,
  log: Logger,
): Promise<{ graph: LoadedGraph; digests: Map<string, string> }> {
  const load = () =>
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests before analysis — a static resolution consumer must
    // see inline imports exactly as the kernel does.
    session.loader.loadGraph(entryPath, { desugarImports: true, migrate: true });
  const graph = await load();
  if (session.sealed || session.recorders.length === 0) return { graph, digests: new Map() };
  const served = new Map<string, string>();
  for (const recorder of session.recorders) {
    for (const [url, file] of recorder.served) served.set(url, file);
  }
  const originsByRoot = new Map<string, Map<string, string>>();
  for (const dir of session.manifestsDirs) {
    originsByRoot.set(dir, await readOriginDigests(dir));
  }
  const freshness = await revalidateMutableOciRefs(graph, served, originsByRoot, session.verified);
  if (freshness.staleFiles.length === 0) return { graph, digests: freshness.digests };
  for (const file of freshness.staleFiles) await dropStaleEntry(file, session, log);
  return { graph: await load(), digests: freshness.digests };
}
