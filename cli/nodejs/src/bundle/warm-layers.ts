import {
  IntegrityError,
  type LoadedGraph,
  type LoadedModule,
  type PlatformTarget,
} from "@telorun/analyzer";
import {
  defaultTransportRegistry,
  hostPlatformTarget,
  moduleArtifactFor,
  moduleDirectoryFor,
  readOwnerManifest,
} from "@telorun/kernel";

/**
 * Pre-materialize every module layer a `target` platform could need.
 *
 * This is `telo install`'s make-this-offline pass. `telo run` materializes layers
 * lazily — a controller layer when its candidate wins resolution, an asset layer
 * on first module-relative access — so warming here is an optimization, never a
 * correctness requirement. That is the point of the change it replaces:
 * previously a cold `telo run` failed outright because payloads landed on disk
 * only after the load that needed them.
 *
 * `target` defaults to the host but is explicit so a baked image
 * (`TELO_CACHE_DIR`) can be built from a machine of a different architecture —
 * without it, cross-building a `linux/arm64` image on a darwin laptop would cache
 * the wrong binaries.
 *
 * Best-effort per module for transient fetch failures (reported and skipped —
 * the manifest is cached either way, and `run` will fetch what it needs). An
 * integrity failure, a malformed layer index, and a tar entry escaping the module
 * directory are all hard: a tampered or corrupt artifact must never be used, and
 * a bad index is an authoring error the publisher has to fix.
 *
 * Returns the number of layers materialized.
 */
export async function warmModuleLayers(
  graph: LoadedGraph,
  entryDir: string,
  registryUrl: string,
  manifestsDir: string,
  target: PlatformTarget,
  onWarn: (message: string) => void,
): Promise<number> {
  const transports = defaultTransportRegistry(registryUrl);
  const seen = new Set<string>();
  let count = 0;

  for (const [, module] of graph.modules as Map<string, LoadedModule>) {
    const file = module.owner;
    if (seen.has(file.source)) continue;
    seen.add(file.source);

    // A malformed index is an authoring error the publisher must fix, so it
    // propagates rather than being downgraded to a warning.
    const artifact = moduleArtifactFor({
      pinnedRef: file.requestedUrl,
      layers: readOwnerManifest(file.text).layers,
      moduleDir: moduleDirectoryFor(
        file.requestedUrl,
        file.source,
        entryDir,
        registryUrl,
        manifestsDir,
      ),
      transports,
    });
    if (!artifact) continue;

    try {
      count += (await artifact.materializeAll(target)).length;
    } catch (err) {
      if (err instanceof IntegrityError) throw err;
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "ERR_MODULE_LAYER_INTEGRITY" || code === "ERR_MODULE_LAYER_INVALID") throw err;
      onWarn(
        `could not warm layers for ${file.requestedUrl}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return count;
}

/**
 * Parse a `--platform` value into a target. Accepts the familiar
 * `os/arch[/libc]` shorthand (`linux/amd64`, `linux/arm64/musl`) in the same
 * OCI/GOOS vocabulary the published selectors use. Omitted entirely, the host is
 * the target.
 */
export function parsePlatformTarget(value: string | undefined): PlatformTarget {
  if (!value) return hostPlatformTarget();
  const parts = value
    .split("/")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `--platform '${value}' is not an os/arch[/libc] triple, e.g. 'linux/amd64' or 'linux/arm64/musl'.`,
    );
  }
  return { os: parts[0], arch: parts[1], ...(parts[2] ? { libc: parts[2] } : {}) };
}

/** Label for the install output — `linux/amd64/gnu`, or what the host resolved
 *  to, with an unknown axis shown rather than hidden. */
export function describePlatformTarget(target: PlatformTarget): string {
  return [target.os ?? "unknown", target.arch ?? "unknown", target.libc]
    .filter((p): p is string => p !== undefined)
    .join("/");
}
