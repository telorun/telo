import { Kernel, LocalFileSource } from "@telorun/kernel";
import type { ResourceContext, Runnable } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";
import { fileURLToPath } from "url";

class BufferedWritable extends Writable {
  private chunks: Buffer[] = [];

  _write(chunk: Buffer | string, _encoding: string, cb: () => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }

  get content(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export const args = {
  filter: { type: "string" as const, alias: "f", description: "Filter tests by name substring" },
};

export const schema = Type.Object({
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

function globToRegex(pattern: string): RegExp {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(.+/)?")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`^${re}$`);
}

function discoverTests(
  baseDir: string,
  include: string[],
  exclude: string[],
  filter?: string,
): string[] {
  const entries = fs.readdirSync(baseDir, { recursive: true, encoding: "utf8" });
  const includeRe = include.map(globToRegex);
  const excludeRe = exclude.map(globToRegex);

  const results: string[] = [];
  // Dedupe by realpath: pnpm symlinks workspace packages into multiple
  // node_modules locations, so the same test file can be reached via
  // many paths. Without dedupe, recursive traversal yields the same yaml
  // dozens of times under different prefixes.
  const seen = new Set<string>();

  for (const entry of entries) {
    const rel = entry.replace(/\\/g, "/");
    // Hard-skip node_modules: those are always symlinked workspace dupes
    // (or vendored copies that shouldn't run as workspace tests). The
    // user-facing `exclude` defaults to `__fixtures__` only, but
    // node_modules is a hard architectural skip.
    if (rel.split("/").includes("node_modules")) continue;
    if (!includeRe.some((re) => re.test(rel))) continue;
    if (excludeRe.some((re) => re.test(rel))) continue;
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
 * the manifest, layered under (and overridden by) process.env.
 *
 * Keys already present in process.env take precedence (same as CLI behaviour).
 */
function buildEnvForManifest(manifestPath: string): Record<string, string | undefined> {
  const dir = path.dirname(path.resolve(manifestPath));
  const base = parseEnvFile(tryReadFile(path.join(dir, ".env")));
  const local = parseEnvFile(tryReadFile(path.join(dir, ".env.local")));
  return { ...base, ...local, ...process.env };
}

async function runOneTest(
  testPath: string,
  captureOutput: boolean,
  parentStdout: NodeJS.WritableStream,
  parentStderr: NodeJS.WritableStream,
): Promise<TestResult> {
  const start = Date.now();
  const stdout = captureOutput ? new BufferedWritable() : parentStdout;
  const stderr = captureOutput ? new BufferedWritable() : parentStderr;
  try {
    const kernel = new Kernel({
      env: buildEnvForManifest(testPath),
      stdout,
      stderr,
      sources: [new LocalFileSource()],
    });
    await kernel.load(testPath);
    await kernel.start();
    return {
      path: testPath,
      label: "",
      passed: kernel.exitCode === 0,
      durationMs: Date.now() - start,
      output: captureOutput ? (stdout as BufferedWritable).content + (stderr as BufferedWritable).content : undefined,
    };
  } catch (err) {
    return {
      path: testPath,
      label: "",
      passed: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      output: captureOutput ? (stdout as BufferedWritable).content + (stderr as BufferedWritable).content : undefined,
    };
  }
}

export async function create(
  manifest: SuiteManifest,
  ctx: ResourceContext,
): Promise<Runnable> {
  const { bold, red, green, yellow, dim } = createColors(ctx.stderr);

  return {
    run: async () => {
      const sourceUrl = ctx.moduleContext.source;
      const baseDir = sourceUrl.startsWith("file://")
        ? path.dirname(fileURLToPath(sourceUrl))
        : process.cwd();

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

      for (const testPath of tests) {
        const label = labelFor(testPath, baseDir);
        const result = await runOneTest(testPath, !singleTest, ctx.stdout, ctx.stderr);
        result.label = label;
        results.push(result);

        if (result.passed) {
          ctx.stdout.write(green("PASS") + " " + dim(label) + " " + dim(`(${result.durationMs}ms)`) + "\n");
        } else {
          ctx.stderr.write(red("FAIL") + " " + label + " " + dim(`(${result.durationMs}ms)`) + "\n");
          if (result.output) {
            ctx.stderr.write(result.output);
          }
          if (result.error) {
            ctx.stderr.write(dim(`  ${result.error}`) + "\n");
          }
        }
      }

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
