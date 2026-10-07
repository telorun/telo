#!/usr/bin/env node
// Bumps every pinned import in the repo's authored manifests to the latest published version.
//
// `telo upgrade` already does the work for one manifest; what's missing is knowing WHICH files to
// hand it. Discovery can't be a glob of `*/telo.yaml`: an example may ship several runnable
// manifests under one directory (`examples/aws/lambda/{direct,sqs,http-api,multi-kind}.yaml`), and
// `telo upgrade <dir>` only ever resolves `<dir>/telo.yaml`. So we walk for files instead, and
// select on content — a file with a top-level `imports:` block is a module doc by definition,
// since a partial file may not carry one.
//
// Only `examples/`, `starters/`, `apps/` and `blueprints/` are scanned by default. `modules/`,
// `benchmarks/`, `tests/` and the root test suite import by relative path
// (`../../modules/http-server`), which carries no version to bump — passing them would print noise
// and change nothing.
//
// Every discovered path goes to ONE `telo upgrade --recursive` invocation, not one per file: the
// command shares a single visited set across its arguments, so a library reached both directly and
// as a sibling import is upgraded once, and recursion is cycle-safe.
//
// Usage:
//   node scripts/upgrade-imports.mjs                    # examples, starters, apps, blueprints
//   node scripts/upgrade-imports.mjs --dry-run          # show what would change
//   node scripts/upgrade-imports.mjs examples/todo-app  # narrow the scan to a subtree
//   node scripts/upgrade-imports.mjs --include-prerelease
//   node scripts/upgrade-imports.mjs --pin-local        # also repin relative imports of released
//                                                       # modules whose change has shipped
//   node scripts/upgrade-imports.mjs --output=json      # the CLI's result envelope on stdout
//
// Flags are forwarded verbatim to `telo upgrade`; positionals narrow the roots that are scanned — so
// a flag taking a value is written `--flag=value`. This script's own lines go to stderr, leaving
// stdout to the CLI.
// Env: TELO_CLI overrides the command used to run the CLI (default: bun, falling back to node).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOTS = ["examples", "starters", "apps", "blueprints"];

// `.telo` holds the manifest/npm caches — copies of PUBLISHED manifests, whose pins are the
// artifact's own and are not ours to rewrite. The rest are ordinary build/vendor noise.
const SKIP_DIRS = new Set([".telo", "node_modules", "dist", ".git", "target", "public"]);

/** Every `.yaml`/`.yml` under `dir`, minus the skipped subtrees. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// A module doc's `imports:` is a top-level key, so it sits at column 0. Matching the raw text
// rather than parsing keeps this independent of the custom YAML tags (`!ref`, `!cel`) a real
// parse would need registered.
const hasImports = (file) => /^imports:/m.test(readFileSync(file, "utf-8"));

/**
 * How to run the repo's CLI: bun on the TypeScript entry, else the built Node bin.
 *
 * `--pin-local` always takes the built Node bin. It decides from the release plan, and the plan is
 * only meaningful there: measured on a tree where `telo release status` under Node reports nothing
 * to release, the same command under bun reports every module's payload as changed — so under bun
 * every relative import would be kept local for a reason that is not true.
 */
function resolveCli(needsReleasePlan) {
  if (process.env.TELO_CLI) {
    const parts = process.env.TELO_CLI.split(" ").filter(Boolean);
    return { command: parts[0], prefix: parts.slice(1) };
  }
  if (!needsReleasePlan) {
    const bun = spawnSync("bun", ["--version"], { stdio: "ignore" });
    if (bun.status === 0) return { command: "bun", prefix: [join(ROOT, "cli/nodejs/bin/telo.ts")] };
  }

  const nodeBin = join(ROOT, "cli/nodejs/bin/telo.mjs");
  if (!existsSync(join(ROOT, "cli/nodejs/dist/cli.js"))) {
    console.error(
      needsReleasePlan
        ? "--pin-local needs the built CLI and cli/nodejs/dist is not built.\n" +
            "Run `pnpm -r --if-present build`, or set TELO_CLI."
        : "bun is not on PATH and cli/nodejs/dist is not built.\n" +
            "Install bun, run `pnpm --filter @telorun/cli build`, or set TELO_CLI.",
    );
    process.exit(1);
  }
  return { command: process.execPath, prefix: [nodeBin] };
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const roots = args.filter((a) => !a.startsWith("-"));
const pinLocal = flags.includes("--pin-local");
const json = flags.includes("--output=json");

const scanRoots = (roots.length > 0 ? roots : DEFAULT_ROOTS).map((r) => resolve(ROOT, r));
for (const dir of scanRoots) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${relative(ROOT, dir) || dir}`);
    process.exit(1);
  }
}

const manifests = scanRoots
  .flatMap((dir) => walk(dir))
  .filter(hasImports)
  .sort()
  .map((f) => relative(ROOT, f));

if (manifests.length === 0) {
  console.error("No manifests with an `imports:` block found.");
  process.exit(0);
}

console.error(`Upgrading imports in ${manifests.length} manifest(s):`);
for (const m of manifests) console.error(`  ${m}`);

// A test or fixture manifest imports the modules it exercises by relative path on purpose, so
// `--pin-local` is never applied to one: its pinned imports are upgraded like any other, in a
// second invocation without the flag.
const isTestManifest = (file) => file.split(/[\\/]/).some((s) => s === "tests" || s === "__fixtures__");
const runs = pinLocal
  ? [
      { flags, manifests: manifests.filter((m) => !isTestManifest(m)) },
      {
        flags: flags.filter((f) => f !== "--pin-local" && !f.startsWith("--registry")),
        manifests: manifests.filter(isTestManifest),
      },
    ].filter((run) => run.manifests.length > 0)
  : [{ flags, manifests }];

const { command, prefix } = resolveCli(pinLocal);
// Several invocations each print a result envelope; they are merged into one so stdout stays a
// single JSON document.
const merge = json && runs.length > 1;
const envelopes = [];
let status = 0;

for (const run of runs) {
  const result = spawnSync(
    command,
    [...prefix, "upgrade", "--recursive", ...run.flags, ...run.manifests],
    {
      cwd: ROOT,
      stdio: merge ? ["inherit", "pipe", "inherit"] : "inherit",
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  status ||= result.status ?? 1;
  if (merge) envelopes.push(JSON.parse(result.stdout));
}

if (merge) {
  const merged = {};
  for (const envelope of envelopes) {
    for (const [key, value] of Object.entries(envelope)) {
      if (Array.isArray(value)) merged[key] = [...(merged[key] ?? []), ...value];
      else if (typeof value === "number") merged[key] = (merged[key] ?? 0) + value;
      else if (key === "ok") merged[key] = (merged[key] ?? true) && value;
      else merged[key] ??= value;
    }
  }
  process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
}
process.exit(status);
