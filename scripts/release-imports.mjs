#!/usr/bin/env node
// Runs `telo release imports` over every in-repo consumer manifest: each file with a top-level
// `imports:` block under `examples/`, `starters/`, `apps/` and `blueprints/`, tests and fixtures
// included — they import the workspace modules they exercise like any other consumer.
//
// Usage:
//   pnpm run imports -- --as=relative --check     # every workspace import is relative
//   pnpm run imports -- --as=published --dry-run  # what a publication commit would write
//
// Every argument is forwarded to the command, before the manifests, in ONE invocation, so the
// release plan is built once. The exit status is the command's. This script's own lines go to
// stderr, leaving stdout to the CLI.
// Env: TELO_CLI overrides the command used to run the CLI (default: the built Node bin, since the
// release plan `--as=published` reads is only meaningful there).
//
// The publication commit (`publication-commit.mjs`) and the release PR's gate
// (`check-release-imports.mjs`) run the same command through the exports below.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONSUMER_ROOTS = ["examples", "starters", "apps", "blueprints"];

// `.telo` holds copies of PUBLISHED manifests, whose imports are the artifact's own; `.claude`
// holds other branches' worktrees. The rest are build and vendor output.
const SKIP_DIRS = new Set([".telo", "node_modules", "dist", ".git", "target", "public", ".claude"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// A module doc's `imports:` is a top-level key at column 0; matching the text needs none of the
// custom tags a parse would.
const hasImports = (file) => /^imports:/m.test(readFileSync(file, "utf-8"));

/** The YAML files under the four roots that git tracks or would add (`.gitignore` honoured),
 *  or undefined when `root` is not in a git repository. */
function gitListed(root) {
  try {
    const roots = CONSUMER_ROOTS.filter((name) => existsSync(join(root, name)));
    if (roots.length === 0) return [];
    return execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...roots], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\0")
      .filter((file) => /\.ya?ml$/.test(file) && existsSync(join(root, file)))
      .filter((file) => !file.split("/").some((part) => SKIP_DIRS.has(part)))
      .map((file) => join(root, file));
  } catch (error) {
    if (/not a git repository/i.test(`${error.stderr ?? ""}`)) return undefined;
    throw error;
  }
}

/** Every consumer manifest under `root`'s four roots, relative to `root`, sorted. Git decides
 *  what exists (tracked, or untracked and not ignored); outside a git repository the roots
 *  are walked instead, and nothing is ignored. */
export function consumerManifests(root = ROOT) {
  let files = gitListed(root);
  if (files === undefined) {
    console.error(`${root} is not in a git repository: walking the roots, .gitignore is not honoured.`);
    files = CONSUMER_ROOTS.map((name) => join(root, name))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => walk(dir));
  }
  return files
    .filter(hasImports)
    .sort()
    .map((file) => relative(root, file));
}

/** The command running this checkout's CLI: `TELO_CLI`, else the built Node bin. */
export function resolveCli() {
  if (process.env.TELO_CLI) {
    const parts = process.env.TELO_CLI.split(" ").filter(Boolean);
    return { command: parts[0], prefix: parts.slice(1) };
  }
  if (!existsSync(join(ROOT, "cli/nodejs/dist/cli.js"))) {
    throw new Error(
      "telo release imports needs the built CLI and cli/nodejs/dist is not built. " +
        "Run `pnpm -r --if-present build`, or set TELO_CLI.",
    );
  }
  return { command: process.execPath, prefix: [join(ROOT, "cli/nodejs/bin/telo.mjs")] };
}

/**
 * The command under `-o json` over `manifests` (relative to `cwd`), its stderr passed through:
 * `{ status, result }`, `result` the parsed envelope or undefined when stdout held none.
 */
export function releaseImportsJson({ cwd = ROOT, args, manifests }) {
  const { command, prefix } = resolveCli();
  const run = spawnSync(command, [...prefix, "-o", "json", "release", "imports", ...args, ...manifests], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  let result;
  try {
    result = run.stdout.trim() ? JSON.parse(run.stdout) : undefined;
  } catch {
    result = undefined;
  }
  return { status: run.status, result };
}

/** One line per import an envelope lists in `keptRelative` and `errors`. */
export function describeImports(entries) {
  return entries.map((entry) => {
    const where = [entry.manifest, entry.alias !== undefined ? `${entry.alias}: ${entry.source}` : undefined]
      .filter(Boolean)
      .join("  ");
    return `${where}  ${entry.reason ?? entry.message}`;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const manifests = consumerManifests();
  if (manifests.length === 0) {
    console.error("No manifests with an `imports:` block found.");
    process.exit(0);
  }
  console.error(`telo release imports over ${manifests.length} manifest(s)`);

  let cli;
  try {
    cli = resolveCli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const result = spawnSync(cli.command, [...cli.prefix, "release", "imports", ...args, ...manifests], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
