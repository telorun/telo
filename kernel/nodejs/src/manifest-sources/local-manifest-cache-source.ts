import {
  manifestCacheKey,
  splitIntegrity,
  verifyIntegrity,
  type LoadedGraph,
  type ManifestSource,
} from "@telorun/analyzer";
import { statSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { hostEnv } from "../host-env.js";
import { TransportRegistry, defaultTransportRegistry } from "../transports/transport-registry.js";
import { findWorkspaceRoot } from "../workspace-marker.js";

const CACHE_SUBDIR = ".telo/manifests";

/** Verify that `candidate` resolves to a path under `root`. Returns the
 *  candidate path on success, `null` when any segment escapes the root.
 *  Guards against `..` segments inside module refs or HTTP pathnames. */
function joinUnder(root: string, ...segments: string[]): string | null {
  if (segments.some((s) => s === "")) return null;
  const candidate = path.join(root, ...segments);
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return candidate;
}

/** Single source of truth for URL → cache path. Used identically by the
 *  reader (cache lookup) and writer (install-time persistence). For any
 *  given import ref — an HTTP(S) URL or an `oci://` ref — both sides land on
 *  the same file: the owning transport supplies
 *  the coordinates and the analyzer's `manifestCacheKey` renders them, the same
 *  grammar the hub's static manifest bucket and the editor's read path use.
 *
 *  Returns `null` for unsupported refs (file://, memory://, relative paths) or
 *  for path-traversal attempts that would escape `cacheRoot`. */
function cachePathForUrl(
  rawUrl: string,
  cacheRoot: string,
  transports: TransportRegistry,
): string | null {
  const coords = transports.cacheCoords(rawUrl);
  if (!coords) return null;
  const key = manifestCacheKey(coords);
  if (!key) return null;
  return joinUnder(cacheRoot, ...key.split("/"));
}

/** The PRE-WORKSPACE-ANCHOR manifest cache for an entry: always
 *  `<entry-dir>/.telo/manifests`, regardless of marker or env override. `null`
 *  for an entry with no local anchor.
 *
 *  A single definition because two things read the old location and they must
 *  agree: the manifest source serves `telo.yaml` from it, and `moduleDirectoryFor`
 *  places that module's LAYERS beside it. Deriving the path twice is how the two
 *  halves end up disagreeing — the manifest resolving from the old root while its
 *  controller layers are looked for under the new one, which is exactly the
 *  offline boot the fallback exists to keep working. */
export function legacyManifestsDir(entryDir: string): string | null {
  return entryDir ? path.join(entryDir, CACHE_SUBDIR) : null;
}

/** `legacyManifestsDir`, or `null` when it would coincide with `current` — so the
 *  fallback is never a second lookup at the same place. */
export function legacyManifestsDirFallback(
  entryDir: string,
  current: string | null,
): string | null {
  const legacy = legacyManifestsDir(entryDir);
  if (legacy === null) return null;
  if (current !== null && path.resolve(legacy) === path.resolve(current)) return null;
  return legacy;
}

/**
 * Reads previously-cached manifest YAMLs from the resolved manifest cache. Sits
 * ahead of `HttpSource` in the source chain — a hit makes boot hermetic, a miss
 * falls through to the network source unchanged.
 *
 * Populated by `writeManifestCache` at install time.
 *
 * On a miss it consults the PRE-WORKSPACE-ANCHOR location
 * (`<entry-dir>/.telo/manifests/`) before giving up. Every other cache in `.telo`
 * costs only CPU when it goes cold; this one costs network, so without the
 * fallback the move to a workspace-anchored root would stop a hermetic setup from
 * booting — its `telo install` output stranded at the old path, with the failure
 * surfacing as a network fetch on a machine that has no route out. Read-only
 * and one directory deep: writes always go to the current root, so the old copy
 * ages out rather than being maintained.
 */
export class LocalManifestCacheSource implements ManifestSource {
  private readonly cacheRoot: string | null;
  private readonly legacyRoot: string | null;
  private readonly transports: TransportRegistry;

  constructor(entryDir: string, manifestsDir?: string) {
    // `manifestsDir` is the resolved manifest-cache directory threaded from a
    // single `resolveCacheRoot` (honours `TELO_CACHE_DIR`); when absent we fall
    // back to the entry-anchored default so library/test callers are unchanged.
    this.cacheRoot = manifestsDir ?? legacyManifestsDir(entryDir);
    this.legacyRoot = legacyManifestsDirFallback(entryDir, this.cacheRoot);
    this.transports = defaultTransportRegistry();
  }

  supports(url: string): boolean {
    return this.tryMap(url) !== null;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const mapped = this.tryMap(url);
    if (!mapped) {
      throw new Error(
        `LocalManifestCacheSource does not support '${url}' (cache miss or unsupported scheme)`,
      );
    }
    // Verify the cached bytes against the import's inline hash before serving.
    // A mismatch is a terminal error — a poisoned cache must never be trusted,
    // and unlike the compiled-validator cache this is not a self-healing miss.
    const { integrity } = splitIntegrity(url);
    if (integrity) {
      const bytes = await fs.readFile(mapped);
      await verifyIntegrity(new Uint8Array(bytes), integrity, splitIntegrity(url).base);
      return { text: bytes.toString("utf-8"), source: pathToFileURL(mapped).href };
    }
    const text = await fs.readFile(mapped, "utf-8");
    return { text, source: pathToFileURL(mapped).href };
  }

  resolveRelative(base: string, relative: string): string {
    // Once `read()` serves a file the canonical `source` is a file:// URL, so
    // any further include: / sibling resolution flows through LocalFileSource.
    // This method exists only for completeness; if the loader ever invokes it
    // with a cache-mapped base, fall back to file-URL semantics.
    const baseDir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, baseDir).href;
  }

  private tryMap(url: string): string | null {
    return this.tryMapIn(url, this.cacheRoot) ?? this.tryMapIn(url, this.legacyRoot);
  }

  private tryMapIn(url: string, root: string | null): string | null {
    if (root === null) return null;
    const candidate = cachePathForUrl(url, root, this.transports);
    if (!candidate) return null;
    // Require a regular file. A directory, dangling symlink, or stat failure
    // (ENOENT, EACCES, EISDIR-on-component) all fall through as a cache miss
    // so the next source in the chain still gets a chance to serve the URL.
    try {
      return statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }
}

/**
 * Map a graph's canonical `source` URL to the on-disk cache file path it
 * should be written to (writer side). Returns `null` for sources that do
 * not need caching — file:// (already on disk), memory:// (transient), or
 * any path that would escape the cache root.
 *
 * Uses the same mapping function as `LocalManifestCacheSource`, so the
 * writer and reader always agree on where every URL lives.
 */
export function cachePathForCanonical(
  canonicalSource: string,
  entryDir: string,
  manifestsDir?: string,
): string | null {
  const cacheRoot = manifestsDir ?? path.join(entryDir, CACHE_SUBDIR);
  return cachePathForUrl(canonicalSource, cacheRoot, defaultTransportRegistry());
}

/**
 * Persist every manifest file reachable from `graph` (owners + partials) to
 * `<entryDir>/.telo/manifests/`, except the entry manifest itself and any
 * file:// or memory:// sources (already on disk or transient).
 *
 * Idempotent: rewrites any existing file with the freshly fetched bytes so
 * a partial re-install converges. Never deletes entries — stale versions
 * stay until `.telo/manifests/` is removed by hand, matching the
 * `.telo/npm/` convention.
 *
 * Returns the list of paths written, for diagnostics.
 */
export async function writeManifestCache(
  graph: LoadedGraph,
  entryDir: string,
  manifestsDir?: string,
): Promise<string[]> {
  const written: string[] = [];
  const seen = new Set<string>();

  for (const [, module] of graph.modules) {
    for (const file of [module.owner, ...module.partials]) {
      if (file.source === graph.rootSource) continue;
      if (seen.has(file.source)) continue;
      seen.add(file.source);

      const target = cachePathForCanonical(file.source, entryDir, manifestsDir);
      if (!target) continue;

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.text, "utf-8");
      written.push(target);
    }
  }

  return written;
}

/** Matches a URL scheme, as distinct from a Windows drive letter. `D:\src`
 *  satisfies RFC 3986's scheme grammar, so the second character is required:
 *  no registered scheme is one letter, and every drive is. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

/** Resolve the entry-anchor directory for the manifest cache.
 *
 * For a file path or `file://` URL: returns the containing directory.
 * For a directory path: returns the directory itself.
 * For ANY other scheme: returns `null` (no local anchor; cache writes skipped).
 *
 * The rule is the scheme, not a list of known ones. Testing only for http(s)
 * left every other scheme falling through to `path.resolve`, which reads it as
 * a relative path: a `memory://app/telo.yaml` entry anchored its cache at
 * `<cwd>/memory:/app/.telo`. On POSIX that is a legal directory name, so the
 * kernel silently created one inside whatever directory it was run from and the
 * cache appeared to work; on Windows `:` is illegal in a filename, so the same
 * load failed at `mkdir`. A transient source has no local anchor by
 * construction — that is what the whole-scheme test says, and it now covers
 * `oci://` and any scheme added later without another edit here. */
export function resolveEntryDir(entryPath: string): string | null {
  const scheme = URL_SCHEME.exec(entryPath)?.[0];
  if (scheme !== undefined && scheme !== "file:") {
    return null;
  }
  let absolute: string;
  if (entryPath.startsWith("file://")) {
    absolute = fileURLToPath(entryPath);
  } else {
    absolute = path.resolve(entryPath);
  }
  try {
    const stat = statSync(absolute);
    return stat.isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    return path.dirname(absolute);
  }
}

/** The single `.telo` cache root for an entry, resolved once and threaded to
 *  every consumer (manifest cache, compiled validators, analysis stamps, npm
 *  install root, cargo target dirs) so none of them re-derive it or read the env
 *  independently.
 *
 *  Precedence: `TELO_CACHE_DIR` (the relocated root a prebuilt image bakes its
 *  deps into) wins; then the directory holding `telo-workspace.yaml`, so every
 *  app in one repo shares a cache instead of each carrying its own copy of the
 *  same manifests, validators, bundles and npm tree; then `<entry-dir>/.telo`.
 *
 *  Anchoring on the marker's LOCATION only — never its `modules:` list, which is
 *  release scope — so a manifest in no release subtree (an example, a test
 *  fixture) shares the cache exactly as an app does. With no marker anywhere
 *  above, this collapses to what it did before the anchor existed, so the file
 *  enables the shared cache rather than gating one and deleting it cannot break
 *  a build.
 *
 *  Returns `null` for an entry with no local anchor — an http(s), `memory://`
 *  or any other non-`file:` scheme — in which case the disk cache is skipped.
 *  Consumers append the conventional subdirs: `manifests/`, `analysis/`,
 *  `validators/`, `controller-src/`, `npm/`. */
export function resolveCacheRoot(entryPath: string): string | null {
  const override = hostEnv().TELO_CACHE_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const entryDir = resolveEntryDir(entryPath);
  if (!entryDir) return null;
  return path.join(findWorkspaceRoot(entryDir) ?? entryDir, ".telo");
}
