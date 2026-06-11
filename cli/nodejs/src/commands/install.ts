import { Loader, flattenForAnalyzer } from "@telorun/analyzer";
import {
  ControllerLoader,
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
} from "@telorun/kernel";
import type { ResourceManifest } from "@telorun/sdk";
import * as path from "path";
import { pathToFileURL } from "url";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";

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
    console.log(
      `  ${log.ok("✓")}  warmed analysis cache in ${log.dim(path.relative(process.cwd(), manifestsDir))}`,
    );
  } catch (err) {
    console.error(
      `  ${log.warn("⚠")}  analysis cache not warmed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function installOne(
  inputPath: string,
  registryUrl: string,
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
  const loader = new Loader({
    extraSources: [new LocalFileSource()],
    registryUrl,
  });
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
    console.error(
      `${displayPath}  ${log.error("error")}  ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }

  // Persist every imported manifest to `<entry-dir>/.telo/manifests/` so the
  // boot path (`telo run`) can resolve every import from disk and skip
  // the registry round-trip. The Dockerfile `COPY --from=build /srv /srv`
  // line then carries this whole tree into the production image.
  if (entryDir && cacheRoot) {
    const manifestsDir = path.join(cacheRoot, "manifests");
    try {
      const written = await writeManifestCache(graph, entryDir, registryUrl, manifestsDir);
      if (written.length > 0) {
        console.log(
          `  ${log.ok("✓")}  cached ${written.length} manifest${written.length !== 1 ? "s" : ""} to ${log.dim(path.relative(process.cwd(), manifestsDir))}`,
        );
      }
    } catch (err) {
      console.error(
        `${displayPath}  ${log.error("error")}  failed to write manifest cache: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  const jobs = collectControllerJobs(manifests);

  if (jobs.length === 0) {
    console.log(log.ok("✓") + `  ${displayPath}: no controllers to install`);
    if (entryDir && cacheRoot) await warmAnalysisCache(entryPath, entryDir, registryUrl, log, cacheRoot);
    return true;
  }

  console.log(`Installing ${jobs.length} controller${jobs.length !== 1 ? "s" : ""} for ${log.dim(displayPath)}`);

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
  const results = await Promise.allSettled(
    jobs.map((job) => controllerLoader.load(job.purls, job.baseUri)),
  );

  let failed = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      console.log(`  ${log.ok("✓")}  ${job.label}`);
    } else {
      failed++;
      const reason = result.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      console.error(`  ${log.error("✗")}  ${job.label}`);
      console.error(`       ${log.dim(msg)}`);
      for (const ref of job.definitions) {
        console.error(`       ${log.dim(`referenced by ${ref.kind} ${ref.name}`)}`);
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failed === 0) {
    console.log(`\n${log.ok("✓")}  ${jobs.length} installed in ${elapsed}s`);
    if (entryDir && cacheRoot) await warmAnalysisCache(entryPath, entryDir, registryUrl, log, cacheRoot);
    return true;
  }
  console.log(
    `\n${log.error(`${failed} failed`)}, ${jobs.length - failed} installed in ${elapsed}s`,
  );
  return false;
}

export async function install(argv: {
  paths: string[];
  registryUrl?: string;
}): Promise<void> {
  const log = createLogger(false);

  // Same fallback chain as `telo run`: --registry-url > TELO_REGISTRY_URL >
  // built-in default. The configured URL drives both the network fetches and
  // the on-disk cache layout (registry-served manifests are stored under
  // `<namespace>/<name>/<version>/...`, everything else under `__http/...`).
  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  let failed = false;
  for (const p of argv.paths) {
    const ok = await installOne(p, registryUrl, log);
    if (!ok) failed = true;
  }

  if (failed) process.exit(1);
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
        }),
    async (argv) => {
      await install(argv as any);
    },
  );
}
