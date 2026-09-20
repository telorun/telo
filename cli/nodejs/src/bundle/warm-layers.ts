import {
  IntegrityError,
  describeSelector,
  normalizeAxisValue,
  type LoadedGraph,
  type LoadedModule,
  type PlatformTarget,
} from "@telorun/analyzer";
import {
  buildSiblingLibraries,
  defaultTransportRegistry,
  hostPlatformTarget,
  moduleArtifactFor,
  moduleDirectoryFor,
  readOwnerManifest,
  type ModuleArtifact,
  type OwnerManifest,
  type SiblingLibraryMap,
} from "@telorun/kernel";

/** One layer the target needs that this warm did not produce. */
export interface LayerGap {
  /** The module's pinned ref, as the manifest named it. */
  readonly module: string;
  /** `undetermined` names axes the target left open; `fetch` is a transfer that
   *  failed. Two causes, two repairs — one message for both would name a flag at
   *  a network failure. */
  readonly cause: "undetermined" | "fetch";
  readonly detail: string;
}

export interface WarmedLayers {
  /** Layers actually materialized for the target platform. */
  materialized: number;
  /** What the target needs and did not get. Empty is the only state a caller
   *  that depends on the cache being complete may proceed from. */
  gaps: LayerGap[];
  /**
   * One artifact handle per module that ships a payload, keyed by the module's
   * canonical source — the same key a `Telo.Definition`'s `metadata.source`
   * carries (mirroring the kernel's `moduleArtifacts` map), so the controller
   * pre-install pass can hand each job its module's artifact. A module whose
   * warm failed transiently is still present: the handle is valid and a later
   * materialization may succeed where this one did not.
   */
  artifacts: Map<string, ModuleArtifact>;
  /**
   * The module-owned libraries each module's controller bundles import by bare
   * specifier, keyed by the declaring module's canonical source — the same join
   * `kernel.load()` performs, and for the same reason: a bundle externalizes
   * `@telorun/cache`, so a controller resolved without it fails to import on a
   * module `telo run` loads fine. Warming is the only pass that holds all three
   * inputs (import edges, owner manifests, artifacts) outside the kernel.
   */
  libraries: Map<string, SiblingLibraryMap>;
}

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
 * **A layer this target needs and did not get is REPORTED, never swallowed.**
 * Two things can leave one behind — a fetch that failed, and a layer
 * constraining an axis the target leaves undetermined — and both used to be a
 * warning on the grounds that `run` fetches lazily. That is sound while a lazy
 * path exists and false for everything this warm is actually for: a baked image
 * and a packaged application both have the warmed tree as their ONLY cache, so a
 * skipped layer is a boot failure reported at build time as a line nobody read.
 * They are returned as `gaps` and the caller refuses (`telo install` exits
 * non-zero, `telo package` writes no file). An integrity failure, a malformed
 * layer index and a tar entry escaping the module directory stay hard here: a
 * tampered artifact must never be used, and a bad index is an authoring error.
 */
export async function warmModuleLayers(
  graph: LoadedGraph,
  entryDir: string,
  manifestsDir: string,
  target: PlatformTarget,
): Promise<WarmedLayers> {
  const transports = defaultTransportRegistry();
  const artifacts = new Map<string, ModuleArtifact>();
  const owners = new Map<string, OwnerManifest>();
  const directories = new Map<string, string | undefined>();
  const seen = new Set<string>();
  const gaps: LayerGap[] = [];
  let materialized = 0;

  for (const [, module] of graph.modules as Map<string, LoadedModule>) {
    const file = module.owner;
    if (seen.has(file.source)) continue;
    seen.add(file.source);

    // A malformed index is an authoring error the publisher must fix, so it
    // propagates rather than being downgraded to a warning.
    const owner = readOwnerManifest(file.text);
    owners.set(file.source, owner);
    const moduleDir = moduleDirectoryFor(
      file.requestedUrl,
      file.source,
      entryDir,
      manifestsDir,
    );
    directories.set(file.source, moduleDir ?? undefined);
    const artifact = moduleArtifactFor({
      pinnedRef: file.requestedUrl,
      layers: owner.layers,
      moduleDir,
      transports,
    });
    if (!artifact) continue;
    artifacts.set(file.source, artifact);

    for (const { layer, axes } of artifact.warmPlan(target).undetermined) {
      gaps.push({
        module: file.requestedUrl,
        cause: "undetermined",
        detail:
          `the ${layer.role} layer ${describeSelector(layer.selector!)} constrains ` +
          `${axes.join(", ")}, which this target leaves undetermined.`,
      });
    }

    try {
      materialized += (await artifact.materializeAll(target)).length;
    } catch (err) {
      if (err instanceof IntegrityError) throw err;
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "ERR_MODULE_LAYER_INTEGRITY" || code === "ERR_MODULE_LAYER_INVALID") throw err;
      gaps.push({
        module: file.requestedUrl,
        cause: "fetch",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const libraries = buildSiblingLibraries(graph, {
    ownerManifests: owners,
    artifactFor: (source) => artifacts.get(source),
    directoryFor: (source) => directories.get(source),
  });

  return { materialized, gaps, artifacts, libraries };
}

/**
 * What is missing and from which module. The REMEDY is the caller's, because the
 * flags are: `telo install` names `--platform` and `--abi`, while `telo package`
 * accepts neither — it takes the abi from the carrier — so one shared sentence
 * would send half its readers to a flag that does not exist.
 */
export function describeGaps(gaps: readonly LayerGap[], remedy?: string): string {
  const lines = [
    `${gaps.length} module layer${gaps.length === 1 ? "" : "s"} could not be materialized, ` +
      `so this cache is incomplete:`,
  ];
  for (const gap of gaps) lines.push(`  ${gap.module}`, `    ${gap.detail}`);
  if (remedy && gaps.some((gap) => gap.cause === "undetermined")) lines.push(remedy);
  return lines.join("\n");
}

/**
 * The target a warm runs for. `--platform` takes the familiar `os/arch[/libc]`
 * shorthand (`linux/amd64`, `linux/arm64/musl`) in the same OCI/GOOS vocabulary
 * the published selectors use; omitted, the host's os, arch and libc are the
 * target.
 *
 * **`--abi` decides it for a NAMED platform, the host for its own.** The process
 * running an install is not the one that will run the app when a `--platform` is
 * named — it may be another Node release, or Bun — so nothing may be assumed
 * there. Without `--platform` the target IS this machine, whose abi the host
 * already reports, and discarding it made a bare `telo install` unable to warm
 * an abi-constrained native layer for the very runtime about to open it.
 */
export function parsePlatformTarget(
  platform: string | undefined,
  abi: string | undefined,
): PlatformTarget {
  const target = platform ? parsePlatformTriple(platform) : { ...hostPlatformTarget() };
  if (platform) delete target.abi;
  if (abi !== undefined) target.abi = normalizeAxisValue("abi", abi, "--abi");
  return target;
}

function parsePlatformTriple(value: string): PlatformTarget {
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
 *  to, with an unknown axis shown rather than hidden, plus the abi when set. */
export function describePlatformTarget(target: PlatformTarget): string {
  const triple = [target.os ?? "unknown", target.arch ?? "unknown", target.libc]
    .filter((p): p is string => p !== undefined)
    .join("/");
  return target.abi === undefined ? triple : `${triple} (abi ${target.abi})`;
}
