import { defaultTransportRegistry, cachePathForCanonical } from "@telorun/kernel";
import { IntegrityError, type LoadedModule, type LoadedGraph } from "@telorun/analyzer";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

/** Marker written into a module's cache dir after a successful extraction.
 *  Registry versions are immutable, so its presence means the bundle is
 *  already on disk and the fetch can be skipped (the marker is written last,
 *  so a partial extraction leaves no marker and re-runs). */
const EXTRACTED_MARKER = ".telo-bundle";

/** True when the module's owner Application/Library doc declares a non-empty
 *  `files:` list — i.e. it ships a payload worth fetching. Reads the graph's
 *  already-parsed manifest so a payload-less module triggers no network at all. */
function declaresFiles(module: LoadedModule): boolean {
  const doc = module.owner.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  ) as { files?: unknown } | undefined;
  return Array.isArray(doc?.files) && doc.files.length > 0;
}

/** A module fetched from the registry / an HTTP URL — its assets live in a
 *  bundle, not on the local disk. file:// (local dev) and memory:// are
 *  skipped: their assets are already where Http.Static resolves them. */
function isRemoteSource(source: string): boolean {
  if (source.startsWith("file://") || source.startsWith("memory://")) return false;
  if (source.startsWith("http://") || source.startsWith("https://")) return true;
  // Registry ref form: namespace/name@version
  return source.includes("@") && source.includes("/");
}

/**
 * For every module in `graph` that ships a `files:` payload from a remote
 * transport, fetch its full artifact through the transport its ref selects and
 * extract the payload into the module's cache directory (next to the cached
 * `telo.yaml`), so a relative `Http.Static` root / bundled controller `path:`
 * resolves on disk exactly as it does in dev.
 *
 * The fetch keys off each module's **pinned** `requestedUrl` (the import ref
 * with its `#sha256-...`), so the transport verifies the manifest against the
 * inline hash and the payload against that manifest's `filesIntegrity` — the
 * Merkle chain stays anchored to the importer's pin.
 *
 * Runs after `writeManifestCache`. Best-effort per module for transient fetch
 * failures (reported and skipped — the manifest itself is still cached), but an
 * integrity failure (`IntegrityError`) or a tar entry escaping the module
 * directory is a hard error (tamper / path-traversal guard).
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
  const transports = defaultTransportRegistry(registryUrl);

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
    // is on disk there is nothing to re-fetch.
    if (existsSync(path.join(moduleDir, EXTRACTED_MARKER))) continue;

    let files;
    try {
      ({ files } = await transports.fetchArtifact(file.requestedUrl));
    } catch (err) {
      // A tamper failure must never be swallowed; a transient fetch failure is
      // best-effort (the manifest is still cached, runtime surfaces a clear
      // error if the payload is actually needed).
      if (err instanceof IntegrityError) throw err;
      onWarn(
        `could not fetch bundle for ${file.requestedUrl}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }

    const realModuleDir = path.resolve(moduleDir) + path.sep;
    for (const entry of files) {
      const dest = path.resolve(moduleDir, entry.name);
      if (!dest.startsWith(realModuleDir)) {
        throw new Error(
          `bundle for ${file.requestedUrl} contains entry '${entry.name}' that resolves outside the module cache directory.`,
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
