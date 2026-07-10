import { cachePathForCanonical } from "@telorun/kernel";
import type { LoadedModule, LoadedGraph } from "@telorun/analyzer";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { computeFilesIntegrity } from "./files-integrity.js";
import { readTarGz } from "./tar.js";

const MANIFEST_FILENAME = "telo.yaml";

/** Marker written into a module's cache dir after a successful extraction.
 *  Registry versions are immutable, so its presence means the bundle is
 *  already on disk and the fetch can be skipped (the marker is written last,
 *  so a partial extraction leaves no marker and re-runs). */
const EXTRACTED_MARKER = ".telo-bundle";

/** True when the module's owner Application/Library doc declares a non-empty
 *  `files:` list — i.e. it ships a `module.tar.gz` artifact worth fetching.
 *  Reads the graph's already-parsed manifest rather than re-parsing the text. */
function declaresFiles(module: LoadedModule): boolean {
  const doc = module.owner.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  ) as { files?: unknown } | undefined;
  return Array.isArray(doc?.files) && doc.files.length > 0;
}

/** The `filesIntegrity` hash declared on the module's owner doc, if any. It
 *  pins the decompressed payload tar; `telo.yaml` itself is already pinned by
 *  the importer's `#sha256-...` hash. */
function filesIntegrityOf(module: LoadedModule): string | undefined {
  const doc = module.owner.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  ) as { filesIntegrity?: unknown } | undefined;
  return typeof doc?.filesIntegrity === "string" ? doc.filesIntegrity : undefined;
}

/** A module fetched from the registry / an HTTP URL — its assets live in a
 *  tarball, not on the local disk. file:// (local dev) and memory:// are
 *  skipped: their assets are already where Http.Static resolves them. */
function isRemoteSource(source: string): boolean {
  if (source.startsWith("file://") || source.startsWith("memory://")) return false;
  if (source.startsWith("http://") || source.startsWith("https://")) return true;
  // Registry ref form: namespace/name@version
  return source.includes("@") && source.includes("/");
}

/** Derive the `module.tar.gz` URL from a manifest's canonical source URL. */
function tarballUrl(manifestSource: string, registryUrl: string): string | null {
  const suffix = `/${MANIFEST_FILENAME}`;
  if (manifestSource.endsWith(suffix)) {
    return `${manifestSource.slice(0, -suffix.length)}/module.tar.gz`;
  }
  // Registry ref form: namespace/name@version
  const atIdx = manifestSource.lastIndexOf("@");
  if (atIdx > 0) {
    const modulePath = manifestSource.slice(0, atIdx);
    const version = manifestSource.slice(atIdx + 1).replace(/^v/, "");
    if (modulePath.includes("/") && version) {
      return `${registryUrl.replace(/\/+$/, "")}/${modulePath}/${version}/module.tar.gz`;
    }
  }
  return null;
}

/**
 * For every module in `graph` that ships a `files:` bundle from the registry,
 * download its `module.tar.gz` and extract it into the module's cache directory
 * (next to the cached `telo.yaml`), so a relative `Http.Static` root / bundled
 * controller `path:` resolves on disk exactly as it does in dev.
 *
 * Runs after `writeManifestCache`. Best-effort per module: a fetch/extract
 * failure is reported and skipped (the manifest itself is still cached); a tar
 * entry escaping the module directory is a hard error (path-traversal guard).
 *
 * Returns the number of bundles extracted.
 */
export async function extractModuleBundles(
  graph: LoadedGraph,
  entryDir: string,
  registryUrl: string,
  manifestsDir: string,
  onWarn: (message: string) => void,
): Promise<number> {
  let count = 0;
  const seen = new Set<string>();

  for (const [, module] of graph.modules) {
    const file = module.owner;
    if (seen.has(file.source)) continue;
    seen.add(file.source);

    if (!isRemoteSource(file.source)) continue;
    if (!declaresFiles(module)) continue;

    const manifestCachePath = cachePathForCanonical(file.source, entryDir, registryUrl, manifestsDir);
    if (!manifestCachePath) continue;
    const moduleDir = path.dirname(manifestCachePath);

    // Extract-once: a pinned registry version is immutable, so once its bundle
    // is on disk there is nothing to re-fetch. Without this every `telo run` of
    // a published app would re-download the whole tarball before booting.
    if (existsSync(path.join(moduleDir, EXTRACTED_MARKER))) continue;

    const url = tarballUrl(file.source, registryUrl);
    if (!url) continue;

    let buf: Buffer;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        onWarn(`could not fetch bundle ${url}: ${res.status} ${res.statusText}`);
        continue;
      }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      onWarn(`could not fetch bundle ${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let entries: Awaited<ReturnType<typeof readTarGz>>;
    try {
      entries = await readTarGz(buf);
    } catch (err) {
      onWarn(`could not unpack bundle ${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Verify the payload against the manifest's `filesIntegrity` before writing
    // anything to disk. A mismatch is a terminal error (not the best-effort
    // onWarn path above) — a tampered bundle must never be extracted. The digest
    // is recomputed from the file contents (framing-independent); the manifest
    // that carries it is itself pinned by the importer's `#sha256-...` hash.
    const integrity = filesIntegrityOf(module);
    if (integrity) {
      const actual = await computeFilesIntegrity(
        entries.map((e) => ({
          name: e.name,
          content: typeof e.content === "string" ? Buffer.from(e.content) : e.content,
        })),
      );
      if (actual !== integrity) {
        throw new Error(
          `Integrity check failed for bundle ${url}: filesIntegrity expected ${integrity}, ` +
            `got ${actual}. The payload does not match the recorded hash — the module may ` +
            `have been tampered with or republished.`,
        );
      }
    }

    const realModuleDir = path.resolve(moduleDir) + path.sep;
    for (const entry of entries) {
      const dest = path.resolve(moduleDir, entry.name);
      if (!dest.startsWith(realModuleDir)) {
        throw new Error(
          `bundle ${url} contains entry '${entry.name}' that resolves outside the module cache directory.`,
        );
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.content);
    }
    await fs.writeFile(path.join(moduleDir, EXTRACTED_MARKER), "");
    count++;
  }

  return count;
}
