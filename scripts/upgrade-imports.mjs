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
// Only `examples/`, `templates/` and `apps/` are scanned by default. `modules/`, `benchmarks/`,
// `tests/` and the root test suite import by relative path (`../../modules/http-server`), which
// carries no version to bump — passing them would print noise and change nothing.
//
// Every discovered path goes to ONE `telo upgrade --recursive` invocation, not one per file: the
// command shares a single visited set across its arguments, so a library reached both directly and
// as a sibling import is upgraded once, and recursion is cycle-safe.
//
// Usage:
//   node scripts/upgrade-imports.mjs                    # examples, templates, apps
//   node scripts/upgrade-imports.mjs --dry-run          # show what would change
//   node scripts/upgrade-imports.mjs examples/todo-app  # narrow the scan to a subtree
//   node scripts/upgrade-imports.mjs --include-prerelease
//
// Flags are forwarded verbatim to `telo upgrade`; positionals narrow the roots that are scanned.
// Env: TELO_CLI overrides the command used to run the CLI (default: bun, falling back to node).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOTS = ["examples", "templates", "apps"];

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

/** How to run the repo's CLI: bun on the TypeScript entry, else the built Node bin. */
function resolveCli() {
  if (process.env.TELO_CLI) {
    const parts = process.env.TELO_CLI.split(" ").filter(Boolean);
    return { command: parts[0], prefix: parts.slice(1) };
  }
  const bun = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (bun.status === 0) return { command: "bun", prefix: [join(ROOT, "cli/nodejs/bin/telo.ts")] };

  const nodeBin = join(ROOT, "cli/nodejs/bin/telo.mjs");
  if (!existsSync(join(ROOT, "cli/nodejs/dist/cli.js"))) {
    console.error(
      "bun is not on PATH and cli/nodejs/dist is not built.\n" +
        "Install bun, run `pnpm --filter @telorun/cli build`, or set TELO_CLI.",
    );
    process.exit(1);
  }
  return { command: process.execPath, prefix: [nodeBin] };
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const roots = args.filter((a) => !a.startsWith("-"));

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
  console.log("No manifests with an `imports:` block found.");
  process.exit(0);
}

console.log(`Upgrading imports in ${manifests.length} manifest(s):`);
for (const m of manifests) console.log(`  ${m}`);

const { command, prefix } = resolveCli();
const result = spawnSync(command, [...prefix, "upgrade", "--recursive", ...flags, ...manifests], {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
