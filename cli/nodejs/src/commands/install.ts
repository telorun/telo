import { Loader, flattenForAnalyzer, type PlatformTarget } from "@telorun/analyzer";
import {
  ControllerLoader,
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  defaultTransportRegistry,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
} from "@telorun/kernel";
import type { ModuleArtifact } from "@telorun/kernel";
import type { ResourceManifest } from "@telorun/sdk";
import * as path from "path";
import { pathToFileURL } from "url";
import type { Argv } from "yargs";
import {
  describePlatformTarget,
  parsePlatformTarget,
  warmModuleLayers,
} from "../bundle/warm-layers.js";
import { createLogger, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine, output } from "../output.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

interface ControllerJob {
  purls: string[];
  baseUri: string;
  /** Human-readable label derived from the first PURL, used for output. */
  label: string;
  /** Definitions that reference this controller set — for diagnostic output on failure. */
  definitions: Array<{ kind: string; name: string }>;
}

/**
 * Walks the manifest graph (following imports), collects every
 * Telo.Definition with a `controllers` array, and dedupes by the exact PURL
 * list so the ControllerLoader cache is hit only once per unique package.
 */
function collectControllerJobs(manifests: ResourceManifest[]): ControllerJob[] {
  const byKey = new Map<string, ControllerJob>();

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition") continue;
    const controllers = (m as any).controllers as string[] | undefined;
    if (!controllers?.length) continue;

    const baseUri = ((m.metadata as any)?.source as string | undefined) ?? "";
    // Cache key mirrors ControllerLoader's own cache key (first PURL), plus the
    // baseUri so two definitions with the same PURL but different local_path
    // resolution roots are treated as independent jobs.
    const key = `${controllers[0]}|${baseUri}`;
    const label = controllers[0];

    const existing = byKey.get(key);
    const ref = { kind: m.kind, name: m.metadata?.name ?? "(unnamed)" };
    if (existing) {
      existing.definitions.push(ref);
      continue;
    }
    byKey.set(key, { purls: controllers, baseUri, label, definitions: [ref] });
  }

  return Array.from(byKey.values());
}

/**
 * Bake the kernel's analysis caches into `<entryDir>/.telo/manifests/` so a
 * prebuilt image boots without re-deriving them. `writeManifestCache` (above)
 * only warms the URL→content manifest cache and `.telo/npm/`; the analysis
 * stamp (`.validated.json`) and the compiled `__validators/` schema cache are
 * produced exclusively by `kernel.load`. Without this pass the runtime
 * `kernel.load` — running on a read-only session rootfs — misses the stamp,
 * re-runs the full validation walk on every boot, and fails to persist either
 * cache (EROFS / ENOENT noise on stderr).
 *
 * Runs the same offline `kernel.load` the runtime uses (LocalFileSource +
 * LocalManifestCacheSource, same registry URL) in `analyzeOnly` mode, so the
 * stamp's content signature matches byte-for-byte at run time. Best-effort:
 * a failure here (e.g. a manifest that fails analysis) is surfaced as a
 * warning but does not fail the install — the runtime re-validates and
 * reports the real error there.
 */
async function warmAnalysisCache(
  entryPath: string,
  entryDir: string,
  registryUrl: string,
  log: Logger,
  cacheRoot: string,
): Promise<void> {
  const manifestsDir = path.join(cacheRoot, "manifests");
  try {
    const kernel = new Kernel({
      registryUrl,
      sources: [
        new LocalFileSource(),
        new LocalManifestCacheSource(entryDir, registryUrl, manifestsDir),
      ],
    });
    await kernel.load(entryPath, { analyzeOnly: true, cacheDir: cacheRoot });
    outLine(
      `  ${log.ok("✓")}  warmed analysis cache in ${log.dim(path.relative(process.cwd(), manifestsDir))}`,
    );
  } catch (err) {
    outErrLine(
      `  ${log.err.warn("⚠")}  analysis cache not warmed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function installOne(
  inputPath: string,
  registryUrl: string,
  platform: PlatformTarget,
  log: Logger,
): Promise<boolean> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
  const displayPath = isUrl ? entryPath : path.relative(process.cwd(), entryPath);

  // The install pass deliberately does NOT register LocalManifestCacheSource:
  // its job is to converge `.telo/manifests/` with whatever the registry
  // currently serves for the pinned versions. Reading from the cache here
  // would freeze stale bytes in place — re-running `telo install` could
  // never refresh a corrupted or outdated entry without manual deletion.
  const entryDir = resolveEntryDir(entryPath);
  // Resolve the `.telo` cache root once (honours TELO_CACHE_DIR so a prebuilt
  // image bakes deps at the relocated root) and thread it to the manifest
  // cache, controller install root, and analysis-warm pass.
  const cacheRoot = resolveCacheRoot(entryPath);
  const loader = new Loader([
    new LocalFileSource(),
    ...defaultTransportRegistry(registryUrl).sources(),
  ]);
  let manifests: ResourceManifest[];
  let graph: Awaited<ReturnType<typeof loader.loadGraph>>;
  try {
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests and the graph walk follows them, so every
    // transitive import is discovered, cached, and analyzed.
    graph = await loader.loadGraph(entryPath, { desugarImports: true });
    if (graph.errors.length > 0) throw graph.errors[0].error;
    manifests = flattenForAnalyzer(graph);
  } catch (err) {
    outErrLine(
      `${displayPath}  ${log.err.error("error")}  ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }

  // The artifact of each module that ships a payload, keyed by canonical source
  // — the key a definition's `metadata.source` carries. The controller
  // pre-install pass below needs it: a published module's bundled controller
  // lives in its artifact's layers, not beside its cached manifest, so a
  // `pkg:telo` candidate resolved without the artifact is env-missing and the
  // job fails on a module `telo run` loads fine.
  let moduleArtifacts: Map<string, ModuleArtifact> | undefined;

  // Persist every imported manifest to `<entry-dir>/.telo/manifests/` so the
  // boot path (`telo run`) can resolve every import from disk and skip
  // the registry round-trip. The Dockerfile `COPY --from=build /srv /srv`
  // line then carries this whole tree into the production image.
  if (entryDir && cacheRoot) {
    const manifestsDir = path.join(cacheRoot, "manifests");
    try {
      const written = await writeManifestCache(graph, entryDir, registryUrl, manifestsDir);
      if (written.length > 0) {
        outLine(
          `  ${log.ok("✓")}  cached ${written.length} manifest${written.length !== 1 ? "s" : ""} to ${log.dim(path.relative(process.cwd(), manifestsDir))}`,
        );
      }
      // Warm every layer this target could need. `run` fetches lazily, so this
      // is purely so a later run (or a baked image) needs no network.
      const warmed = await warmModuleLayers(
        graph,
        entryDir,
        registryUrl,
        manifestsDir,
        platform,
        (msg) => outErrLine(`  ${log.err.warn("⚠")}  ${msg}`),
      );
      moduleArtifacts = warmed.artifacts;
      if (warmed.materialized > 0) {
        outLine(
          `  ${log.ok("✓")}  materialized ${warmed.materialized} module layer${warmed.materialized !== 1 ? "s" : ""} ` +
            `for ${log.dim(describePlatformTarget(platform))}`,
        );
      }
    } catch (err) {
      outErrLine(
        `${displayPath}  ${log.err.error("error")}  failed to write manifest cache: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  const jobs = collectControllerJobs(manifests);

  if (jobs.length === 0) {
    outLine(log.ok("✓") + `  ${displayPath}: no controllers to install`);
    if (entryDir && cacheRoot) await warmAnalysisCache(entryPath, entryDir, registryUrl, log, cacheRoot);
    return true;
  }

  outLine(`Installing ${jobs.length} controller${jobs.length !== 1 ? "s" : ""} for ${log.dim(displayPath)}`);

  // The install root is anchored at the entry manifest's directory, mirroring
  // how `kernel.load(...)` records the entry URL at run time. Every controller
  // — registry or `local_path` — resolves through `<entry-dir>/.telo/npm/`,
  // giving the kernel and all controllers one realpath for `@telorun/sdk`.
  // pathToFileURL handles non-ASCII bytes and Windows drive letters
  // correctly; bare `file://` concatenation breaks on either.
  const entryUrl = isUrl ? entryPath : pathToFileURL(entryPath).toString();
  const controllerLoader = new ControllerLoader({
    entryUrl,
    installRoot: cacheRoot ? path.join(cacheRoot, "npm") : undefined,
  });
  const started = Date.now();
  // `job.baseUri` is the declaring module's canonical source — the exact key
  // `warmModuleLayers` filed its artifact under (and the kernel's
  // `getModuleArtifact` uses at run time).
  const results = await Promise.allSettled(
    jobs.map((job) =>
      controllerLoader.load(job.purls, job.baseUri, undefined, moduleArtifacts?.get(job.baseUri)),
    ),
  );

  let failed = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      outLine(`  ${log.ok("✓")}  ${job.label}`);
    } else {
      failed++;
      const reason = result.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      outErrLine(`  ${log.err.error("✗")}  ${job.label}`);
      outErrLine(`       ${log.err.dim(msg)}`);
      for (const ref of job.definitions) {
        outErrLine(`       ${log.err.dim(`referenced by ${ref.kind} ${ref.name}`)}`);
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failed === 0) {
    outLine(`\n${log.ok("✓")}  ${jobs.length} installed in ${elapsed}s`);
    if (entryDir && cacheRoot) await warmAnalysisCache(entryPath, entryDir, registryUrl, log, cacheRoot);
    return true;
  }
  outLine(
    `\n${log.error(`${failed} failed`)}, ${jobs.length - failed} installed in ${elapsed}s`,
  );
  return false;
}

export async function install(argv: {
  paths: string[];
  registryUrl?: string;
  platform?: string;
}): Promise<void> {
  const log = createLogger(false);

  // The platform whose layers get warmed. Explicit so a baked image can be built
  // from a machine of a different architecture; the host otherwise.
  let platform: PlatformTarget;
  try {
    platform = parsePlatformTarget(argv.platform);
  } catch (err) {
    outErrLine(log.err.error("error") + `  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Same fallback chain as `telo run`: --registry-url > TELO_REGISTRY_URL >
  // built-in default. The configured URL drives both the network fetches and
  // the on-disk cache layout — registry-served manifests are keyed under
  // `registry/<registry-host>/<path…>/<version>/...`, so pointing at a
  // different registry never reuses this one's cached bytes.
  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  let failed = false;
  const installed: string[] = [];
  const failures: string[] = [];
  for (const p of argv.paths) {
    const ok = await installOne(p, registryUrl, platform, log);
    (ok ? installed : failures).push(p);
    if (!ok) failed = true;
  }

  outEmit({ ok: !failed, installed, failed: failures });

  // `process.exitCode`, not `process.exit()`: the structured payload was just
  // written, and on a pipe `write` is asynchronous while `exit` does not flush. A
  // large diagnostic set exceeds the 64 KB pipe buffer, and truncated JSON is a
  // parse failure for the one consumer this format exists for. Returning lets
  // the event loop drain.
  if (failed) process.exitCode = 1;
}

export function installCommand(yargs: Argv): Argv {
  return yargs.command(
    "install <paths..>",
    "Pre-download all controllers referenced by one or more Telo manifests into the local cache",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to YAML manifests, directories containing telo.yaml, or HTTP(S) URLs",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry-url", {
          type: "string",
          describe:
            "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
        })
        .option("platform", {
          type: "string",
          describe:
            "Platform whose module layers to pre-fetch, as os/arch[/libc] " +
            "(e.g. linux/amd64, linux/arm64/musl). Defaults to the host — set it " +
            "when baking an image for a different architecture.",
        }),
    async (argv) => {
      await install(argv as any);
    },
  );
}
