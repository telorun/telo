#!/usr/bin/env node
// Serves the starter gallery locally, in the form a release tag holds it.
//
// `pnpm run starters` copies `starters/` to the gitignored `starters-published/` (a sibling at
// the same depth, so the manifests' relative imports still resolve), rewrites the copy's imports
// with `telo release imports --as=published`, and serves the copy with `starters/serve.yaml`.
// An import of a module with unreleased changes stays relative (the command exits 1); Studio
// refuses such a starter, naming the file — the command lists them and this script counts them.
//
// With `--dir` given, or `STARTERS_DIR` set, nothing is copied: the arguments go to the server as
// they are, which is how CI serves the repository root. Without the built Node CLI (and no
// `TELO_CLI`) the rewrite cannot run: a warning says so and the checkout is served as it is, with
// its relative imports. A rewrite that fails (a registry outage) serves nothing.
//
// Env: TELO_CLI overrides the CLI that rewrites the copy (default: the built Node bin).
//      STARTERS_DIR serves that directory as it is.

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeImports, releaseImportsJson } from "./release-imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_DIR = "starters";
export const COPY_DIR = "starters-published";

// Tests and fixtures import the modules they exercise by relative path on purpose, and are no
// part of a gallery.
const SKIPPED = new Set(["tests", "__fixtures__", "node_modules", ".telo"]);

function manifestsWithImports(dir, root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) manifestsWithImports(path, root, out);
    else if (/\.ya?ml$/.test(entry.name) && /^imports:/m.test(readFileSync(path, "utf8"))) {
      out.push(relative(root, path));
    }
  }
  return out;
}

/**
 * Rebuilds `<root>/<copyDir>` from `<root>/<sourceDir>` and rewrites its manifests' imports through
 * `rewrite(manifests)` — `{ status, result }`, the command's `-o json` outcome, manifests relative
 * to `root`. Returns the manifests it rewrote and the imports that stayed relative.
 */
export function buildPublishedStarters({ root, sourceDir = SOURCE_DIR, copyDir = COPY_DIR, rewrite }) {
  const target = join(root, copyDir);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(root, sourceDir), target, {
    recursive: true,
    filter: (source) => !SKIPPED.has(source.split(/[\\/]/).pop()),
  });
  const manifests = manifestsWithImports(target, root).sort();
  if (manifests.length === 0) return { manifests, kept: [] };
  const { status, result } = rewrite(manifests);
  const kept = result?.keptRelative ?? [];
  const errors = result?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `telo release imports reported errors over the copy of ${sourceDir}/, nothing is served:\n` +
        describeImports(errors).map((line) => `  ${line}`).join("\n"),
    );
  }
  // Exit 1 is the kept-relative outcome; anything else is a failure to rewrite.
  if (status !== 0 && status !== 1) {
    throw new Error(`telo release imports exited ${status} over the copy of ${sourceDir}/.`);
  }
  if (status === 1 && kept.length === 0) {
    throw new Error(`telo release imports exited 1 over the copy of ${sourceDir}/ and reported no import kept relative.`);
  }
  return { manifests, kept };
}

/** Whether the rewrite can run: `TELO_CLI` is set or the Node CLI is built. */
export function rewriteAvailable({ root = ROOT, env = process.env } = {}) {
  return Boolean(env.TELO_CLI) || existsSync(join(root, "cli/nodejs/dist/cli.js"));
}

/** How to start: "as-given" (`--dir` or `STARTERS_DIR`: serve that directory), "checkout" (no
 *  rewrite possible) or "published" (copy and rewrite). */
export function startMode({ args, root = ROOT, env = process.env }) {
  if (args.some((arg) => arg === "--dir" || arg.startsWith("--dir=")) || env.STARTERS_DIR) return "as-given";
  return rewriteAvailable({ root, env }) ? "published" : "checkout";
}

// The workspace's own bun when installed (a container has no bun on PATH).
const BUN = existsSync(join(ROOT, "node_modules/.bin/bun")) ? join(ROOT, "node_modules/.bin/bun") : "bun";

function serve(args) {
  const child = spawn(BUN, [join(ROOT, "cli/nodejs/bin/telo.ts"), join(ROOT, SOURCE_DIR, "serve.yaml"), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const mode = startMode({ args });
  if (mode === "as-given") {
    serve(args);
  } else if (mode === "checkout") {
    console.error(
      `cli/nodejs/dist is not built: serving ${SOURCE_DIR}/ from the checkout with relative imports. ` +
        "Studio refuses every starter that imports a workspace module. " +
        "Run `pnpm -r --if-present build`, then start again, to serve the published form.",
    );
    serve(args);
  } else {
    if (!existsSync(join(ROOT, SOURCE_DIR))) {
      console.error(`${SOURCE_DIR}/ not found under ${ROOT}.`);
      process.exit(1);
    }
    let built;
    try {
      built = buildPublishedStarters({
        root: ROOT,
        rewrite: (manifests) => releaseImportsJson({ args: ["--as=published"], manifests }),
      });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(`${COPY_DIR}/: ${built.manifests.length} manifest(s) rewritten to published imports.`);
    if (built.kept.length > 0) {
      console.error(
        `${built.kept.length} import(s) kept relative (listed above): Studio refuses those starters until their modules are released.`,
      );
    }
    serve(["--dir", COPY_DIR, ...args]);
  }
}
