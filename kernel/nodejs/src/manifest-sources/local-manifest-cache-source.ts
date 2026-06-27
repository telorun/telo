import type { LoadedGraph, ManifestSource } from "@telorun/analyzer";
import { createHash } from "crypto";
import { statSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { hostEnv } from "../host-env.js";

const CACHE_SUBDIR = ".telo/manifests";
const HTTP_NAMESPACE = "__http";
const DEFAULT_MANIFEST_FILENAME = "telo.yaml";
const DEFAULT_REGISTRY_URL = "https://registry.telo.run";
const QUERY_HASH_LENGTH = 12;

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

/** Mirror `HttpSource.read`'s `fetchUrl` derivation: when the URL does not
 *  already point at a YAML file, append `/telo.yaml`. Used by both the
 *  reader and writer so a raw import URL and the canonical source it
 *  resolves to map to the same cache path. */
function normalizePathname(url: string, parsed: URL): string {
  let pathname = parsed.pathname;
  if (!url.includes(".yaml")) {
    pathname = pathname.endsWith("/")
      ? `${pathname}${DEFAULT_MANIFEST_FILENAME}`
      : `${pathname}/${DEFAULT_MANIFEST_FILENAME}`;
  }
  return pathname;
}

/** Compute a short hash of `search + hash` so two URLs that differ only in
 *  query / fragment do not collide at the same cache path. Inserted before
 *  the final extension so the filename stays readable. */
function disambiguatePath(pathname: string, search: string, hash: string): string {
  if (!search && !hash) return pathname;
  const digest = createHash("sha256")
    .update(search + hash)
    .digest("hex")
    .slice(0, QUERY_HASH_LENGTH);
  const ext = path.extname(pathname);
  const base = pathname.slice(0, pathname.length - ext.length);
  return `${base}.${digest}${ext}`;
}

/** Single source of truth for URL → cache path. Used identically by the
 *  reader (cache lookup) and writer (install-time persistence). For any
 *  given import URL — registry ref, direct registry URL, or arbitrary
 *  HTTP — both sides land on the same file.
 *
 *  Returns `null` for unsupported URLs (file://, memory://, relative paths)
 *  or for path-traversal attempts that would escape `cacheRoot`. */
function cachePathForUrl(
  url: string,
  cacheRoot: string,
  registryUrl: string,
): string | null {
  const trimmedRegistry = registryUrl.replace(/\/+$/, "");

  // 1. Registry ref form: namespace/name@version
  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://") &&
    !url.startsWith("/") &&
    !url.startsWith(".") &&
    !url.startsWith("file://") &&
    !url.startsWith("memory://") &&
    url.includes("@") &&
    url.includes("/")
  ) {
    const atIdx = url.lastIndexOf("@");
    if (atIdx <= 0 || atIdx === url.length - 1) return null;
    const modulePath = url.slice(0, atIdx);
    if (!modulePath.includes("/")) return null;
    const version = url.slice(atIdx + 1).replace(/^v/, "");
    if (!version) return null;
    return joinUnder(cacheRoot, modulePath, version, DEFAULT_MANIFEST_FILENAME);
  }

  // 2. HTTP(S) URL — could be a direct registry URL or arbitrary external.
  if (url.startsWith("http://") || url.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const pathname = normalizePathname(url, parsed);

    // 2a. URL is on the configured registry, with no query/fragment:
    //     fold into the registry layout so the writer that received a
    //     registry-ref canonical and the reader that sees a direct URL
    //     both resolve to the same file.
    const normalizedUrl = `${parsed.protocol}//${parsed.host}${pathname}`;
    if (
      !parsed.search &&
      !parsed.hash &&
      (normalizedUrl === trimmedRegistry || normalizedUrl.startsWith(`${trimmedRegistry}/`))
    ) {
      const rel = normalizedUrl.slice(trimmedRegistry.length + 1);
      if (!rel) return null;
      return joinUnder(cacheRoot, ...rel.split("/"));
    }

    // 2b. Arbitrary HTTP(S) URL → __http subtree, with a short query-hash
    //     suffix when query / fragment are present to prevent collisions.
    const cleanPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    const disambiguated = disambiguatePath(cleanPath, parsed.search, parsed.hash);
    return joinUnder(cacheRoot, HTTP_NAMESPACE, parsed.host, ...disambiguated.split("/"));
  }

  return null;
}

/**
 * Reads previously-cached manifest YAMLs from `<entry-dir>/.telo/manifests/`.
 * Sits ahead of `RegistrySource` / `HttpSource` in the source chain — a hit
 * makes boot hermetic, a miss falls through to the network source unchanged.
 *
 * Populated by `writeManifestCache` at install time.
 */
export class LocalManifestCacheSource implements ManifestSource {
  private readonly cacheRoot: string;
  private readonly registryUrl: string;

  constructor(
    entryDir: string,
    registryUrl: string = DEFAULT_REGISTRY_URL,
    manifestsDir?: string,
  ) {
    // `manifestsDir` is the resolved manifest-cache directory threaded from a
    // single `resolveCacheRoot` (honours `TELO_CACHE_DIR`); when absent we fall
    // back to the entry-anchored default so library/test callers are unchanged.
    this.cacheRoot = manifestsDir ?? path.join(entryDir, CACHE_SUBDIR);
    this.registryUrl = registryUrl;
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
    const candidate = cachePathForUrl(url, this.cacheRoot, this.registryUrl);
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
  registryUrl: string,
  manifestsDir?: string,
): string | null {
  const cacheRoot = manifestsDir ?? path.join(entryDir, CACHE_SUBDIR);
  return cachePathForUrl(canonicalSource, cacheRoot, registryUrl);
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
  registryUrl: string = DEFAULT_REGISTRY_URL,
  manifestsDir?: string,
): Promise<string[]> {
  const written: string[] = [];
  const seen = new Set<string>();

  for (const [, module] of graph.modules) {
    for (const file of [module.owner, ...module.partials]) {
      if (file.source === graph.rootSource) continue;
      if (seen.has(file.source)) continue;
      seen.add(file.source);

      const target = cachePathForCanonical(file.source, entryDir, registryUrl, manifestsDir);
      if (!target) continue;

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.text, "utf-8");
      written.push(target);
    }
  }

  return written;
}

/** Resolve the entry-anchor directory for the manifest cache.
 *
 * For a file path or `file://` URL: returns the containing directory.
 * For a directory path: returns the directory itself.
 * For an HTTP(S) URL: returns `null` (no local anchor; cache writes skipped). */
export function resolveEntryDir(entryPath: string): string | null {
  if (entryPath.startsWith("http://") || entryPath.startsWith("https://")) {
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
 *  every consumer (manifest cache, compiled validators, analysis stamp, npm
 *  install root) so none of them re-derive it or read the env independently.
 *
 *  `TELO_CACHE_DIR` (the relocated root a prebuilt image bakes its deps into)
 *  wins; otherwise the root sits beside the entry at `<entry-dir>/.telo`.
 *  Returns `null` for http(s) entries with no local anchor (disk cache skipped).
 *  Consumers append the conventional subdirs: `manifests/`, `manifests/__validators/`,
 *  `npm/`. */
export function resolveCacheRoot(entryPath: string): string | null {
  const override = hostEnv().TELO_CACHE_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const entryDir = resolveEntryDir(entryPath);
  return entryDir ? path.join(entryDir, ".telo") : null;
}
