import { selectByPatterns } from "@telorun/glob";
import type { ResourceContext, RuntimeRun, Runnable, Stream } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const DEFAULT_CONCURRENCY = 3;

export const args = {
  filter: { type: "string" as const, alias: "f", description: "Filter tests by name substring" },
};

const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
  include: Type.Optional(
    Type.Array(Type.String()),
  ),
  exclude: Type.Optional(
    Type.Array(Type.String()),
  ),
  filter: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
});

type SuiteManifest = Static<typeof schema>;

interface TestResult {
  path: string;
  label: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  output?: string;
}

function createColors(stream: NodeJS.WritableStream) {
  const useColor = (stream as any).isTTY ?? false;
  const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: (t: string) => c("1", t),
    red: (t: string) => c("31", t),
    green: (t: string) => c("32", t),
    yellow: (t: string) => c("33", t),
    dim: (t: string) => c("2", t),
  };
}

function discoverTests(
  baseDir: string,
  include: string[],
  exclude: string[],
  filter?: string,
): string[] {
  const entries = fs.readdirSync(baseDir, { recursive: true, encoding: "utf8" });
  const rels = entries.map((entry) => entry.replace(/\\/g, "/"));

  // Match with the monorepo's single glob engine. `applyDefaultIgnore: false`
  // skips only the soft tier; the hard tier still denies `node_modules` — the
  // symlinked workspace dupes / vendored copies that must never run as
  // workspace tests — so discovery only adds the user-facing `exclude`
  // (defaults to __fixtures__).
  const selected = selectByPatterns(rels, include, {
    applyDefaultIgnore: false,
    exclude,
  });

  // Dedupe by realpath: pnpm symlinks workspace packages into multiple
  // node_modules locations, so the same test file can be reached via
  // many paths. Without dedupe, recursive traversal yields the same yaml
  // dozens of times under different prefixes.
  const seen = new Set<string>();
  const results: string[] = [];
  for (const rel of selected) {
    if (filter && !rel.includes(filter)) continue;
    const abs = path.resolve(baseDir, rel);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      real = abs;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    results.push(abs);
  }
  results.sort();
  return results;
}

function labelFor(testPath: string, baseDir: string): string {
  return path.relative(baseDir, testPath);
}

function tryReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseEnvFile(content: string | null): Record<string, string> {
  if (!content) return {};
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Loads .env and .env.local files (in that order) from the directory of
 * the manifest, layered under (and overridden by) the host environment.
 *
 * `hostEnv` is the suite controller's `ctx.env` (the sanctioned host-env
 * snapshot) — not the locked `process.env` — and takes precedence over the
 * .env files, matching CLI behaviour.
 */
function buildEnvForManifest(
  manifestPath: string,
  hostEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const dir = path.dirname(path.resolve(manifestPath));
  const base = parseEnvFile(tryReadFile(path.join(dir, ".env")));
  const local = parseEnvFile(tryReadFile(path.join(dir, ".env.local")));
  return { ...base, ...local, ...hostEnv };
}

/**
 * Drain one of a run's output streams, optionally forwarding each chunk on as it
 * arrives.
 *
 * Both at once is the point: with several tests in flight their output has to be
 * withheld until the test finishes, or two workers interleave mid-line; with a
 * single test there is nothing to interleave with and the author wants to watch
 * it happen. The seam returns streams rather than captured text precisely so this
 * is the caller's choice.
 */
async function collect(
  stream: Stream<string>,
  forwardTo: NodeJS.WritableStream | undefined,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (forwardTo) forwardTo.write(chunk);
    else text += chunk;
  }
  return text;
}

async function runOneTest(
  testPath: string,
  captureOutput: boolean,
  parentStdout: NodeJS.WritableStream,
  parentStderr: NodeJS.WritableStream,
  hostEnv: Record<string, string | undefined>,
  runtime: ResourceContext["runtime"],
): Promise<TestResult> {
  const start = Date.now();
  let run: RuntimeRun;
  try {
    // The host's own manifest machinery, reached through the SDK rather than by
    // importing the kernel — so a published `test` module binds to a versioned
    // contract instead of to whatever kernel happens to load it. Isolation is the
    // kernel's to choose; this side only says "run this manifest".
    run = await runtime.run(testPath, { env: buildEnvForManifest(testPath, hostEnv) });
  } catch (err) {
    return {
      path: testPath,
      label: "",
      passed: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Drain both streams concurrently with waiting for the exit code. A stream
  // left unread stalls the child once its channel fills — the same backpressure
  // a pipe has — so neither may be skipped.
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(run.stdout, captureOutput ? undefined : parentStdout),
    collect(run.stderr, captureOutput ? undefined : parentStderr),
    run.exitCode,
  ]);

  return {
    path: testPath,
    label: "",
    passed: exitCode === 0,
    durationMs: Date.now() - start,
    output: captureOutput ? stdout + stderr : undefined,
  };
}

export async function create(
  manifest: SuiteManifest,
  ctx: ResourceContext,
): Promise<Runnable> {
  const { bold, red, green, yellow, dim } = createColors(ctx.stderr);

  return {
    run: async () => {
      // The suite discovers test manifests by walking the declaring module's own
      // directory. `resolveModuleFile` is what knows where that is (an artifact
      // directory for a published module, the manifest's directory locally), so
      // discovery never silently falls back to the process working directory.
      const baseUri = await ctx.resolveModuleFile("./");
      if (!baseUri.startsWith("file://")) {
        throw new Error(
          `Test.Suite cannot discover tests: the declaring module resolved to '${baseUri}', ` +
            `which is not a local directory.`,
        );
      }
      const baseDir = path.resolve(fileURLToPath(baseUri));

      const include = manifest.include ?? ["**/tests/*.yaml"];
      const exclude = manifest.exclude ?? ["**/__fixtures__/**"];
      const filter = (ctx.args.filter as string) || (ctx.args._[0] as string) || manifest.filter;

      const tests = discoverTests(baseDir, include, exclude, filter);

      if (tests.length === 0) {
        ctx.stderr.write(bold(yellow(`Test.Suite.${manifest.metadata.name}: no tests found`)) + "\n");
        return;
      }

      const singleTest = tests.length === 1;
      const results: TestResult[] = [];

      const requestedConcurrency = manifest.concurrency ?? DEFAULT_CONCURRENCY;
      const concurrency = singleTest ? 1 : Math.max(1, Math.min(requestedConcurrency, tests.length));

      let nextIdx = 0;
      const worker = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= tests.length) return;
          const testPath = tests[i];
          const label = labelFor(testPath, baseDir);
          const result = await runOneTest(
            testPath,
            !singleTest,
            ctx.stdout,
            ctx.stderr,
            ctx.env,
            ctx.runtime,
          );
          result.label = label;
          results.push(result);

          if (result.passed) {
            ctx.stdout.write(green("PASS") + " " + dim(label) + " " + dim(`(${result.durationMs}ms)`) + "\n");
          } else {
            // Compose the whole FAIL block into one write so a parallel
            // worker's output can't interleave between the header, captured
            // output, and error line on stderr.
            let block = red("FAIL") + " " + label + " " + dim(`(${result.durationMs}ms)`) + "\n";
            if (result.output) block += result.output;
            if (result.error) block += dim(`  ${result.error}`) + "\n";
            ctx.stderr.write(block);
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      const passed = results.filter((r) => r.passed);
      const failed = results.filter((r) => !r.passed);

      if (!singleTest) {
        ctx.stdout.write("\n" + bold("Test Suite Results") + "\n");
        ctx.stdout.write(
          green(`  Passed: ${passed.length}`) +
            (failed.length > 0 ? "  " + red(`Failed: ${failed.length}`) : "") +
            "  " +
            dim(`Total: ${results.length}`) +
            "\n",
        );
      }

      if (failed.length > 0) {
        ctx.requestExit(1);
      }
    },
  };
}
