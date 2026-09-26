import { EngineIntegrityError, extractEngine, sha512Integrity } from "./engine-archive.js";
import type { EngineCache } from "./host-seams.js";
import type { CatalogReading } from "./version-catalog.js";

/** An engine that is neither cached nor downloadable right now. No other
 *  engine is substituted for it. */
export class EngineUnavailableError extends Error {}

/**
 * The code of one published telo version's engine: the cached copy after its
 * digest is rechecked, else a verified download that is then cached. A cached
 * copy that no longer hashes to its recorded digest is reported through `warn`
 * and replaced by a fresh download. (The bundled engine is the host's own and
 * is never loaded through here.)
 */
export async function loadEngine(options: {
  version: string;
  catalog: CatalogReading;
  cache: EngineCache;
  speaks: readonly number[];
  fetch?: typeof globalThis.fetch;
  warn(message: string): void;
}): Promise<Uint8Array> {
  const { version, catalog, cache } = options;
  const cached = await cache.get(version);
  if (cached) {
    const digest = await sha512Integrity(cached.bytes);
    if (digest === cached.digest) return cached.bytes;
    options.warn(
      `telo: the cached telo ${version} engine no longer matches the digest recorded when it was ` +
        `stored (${cached.digest}, now ${digest}); it was refused and is fetched again.`,
    );
  }

  const entry = catalog.offered.find((e) => e.version === version);
  if (!entry) {
    throw new EngineUnavailableError(
      catalog.source === "registry"
        ? `telo ${version} has no published engine this editor can run.`
        : `telo ${version} is not cached and the engine registry is unreachable` +
            (catalog.failure ? ` (${catalog.failure})` : "") + ".",
    );
  }
  let tarball: Uint8Array;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(entry.tarball);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    tarball = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new EngineUnavailableError(
      `telo ${version} is not cached and its engine could not be downloaded from ${entry.tarball}: ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const bytes = await extractEngine(version, tarball, entry.integrity, options.speaks);
  await cache.put(version, { bytes, digest: await sha512Integrity(bytes) });
  return bytes;
}

export { EngineIntegrityError };
