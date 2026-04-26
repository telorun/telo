import { Loader } from "@telorun/analyzer";
import { ControllerLoader, LocalFileSource } from "@telorun/kernel";
import type { ResourceManifest } from "@telorun/sdk";
import * as path from "path";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";

interface ControllerJob {
  purls: string[];
  baseUri: string;
  /** Human-readable label derived from the first PURL, used for output. */
  label: string;
  /** Definitions that reference this controller set — for diagnostic output on failure. */
  definitions: Array<{ kind: string; name: string }>;
}

/**
 * Walks the manifest graph (following Telo.Import), collects every
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

async function installOne(inputPath: string, log: Logger): Promise<boolean> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
  const displayPath = isUrl ? entryPath : path.relative(process.cwd(), entryPath);

  const loader = new Loader([new LocalFileSource()]);
  let manifests: ResourceManifest[];
  try {
    manifests = await loader.loadManifests(entryPath);
  } catch (err) {
    console.error(
      `${displayPath}  ${log.error("error")}  ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }

  const jobs = collectControllerJobs(manifests);

  if (jobs.length === 0) {
    console.log(log.ok("✓") + `  ${displayPath}: no controllers to install`);
    return true;
  }

  console.log(`Installing ${jobs.length} controller${jobs.length !== 1 ? "s" : ""} for ${log.dim(displayPath)}`);

  const controllerLoader = new ControllerLoader();
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
    return true;
  }
  console.log(
    `\n${log.error(`${failed} failed`)}, ${jobs.length - failed} installed in ${elapsed}s`,
  );
  return false;
}

export async function install(argv: { paths: string[] }): Promise<void> {
  const log = createLogger(false);

  let failed = false;
  for (const p of argv.paths) {
    const ok = await installOne(p, log);
    if (!ok) failed = true;
  }

  if (failed) process.exit(1);
}

export function installCommand(yargs: Argv): Argv {
  return yargs.command(
    "install <paths..>",
    "Pre-download all controllers referenced by one or more Telo manifests into the local cache",
    (y) =>
      y.positional("paths", {
        describe: "Paths to YAML manifests, directories containing telo.yaml, or HTTP(S) URLs",
        type: "string",
        array: true,
        demandOption: true,
      }),
    async (argv) => {
      await install(argv as any);
    },
  );
}
