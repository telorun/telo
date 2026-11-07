#!/usr/bin/env node
// Run from a published package's `prepack` / `postpack` hooks (and the VS Code
// extension's packaging). A relative link in source resolves against whatever ref
// is being viewed; in a tarball it resolves against nothing, so the markdown that
// ships is rewritten to the tag of the version being published.
//
// Usage: node scripts/rewrite-pack-links.mjs <pkg-dir> [--readme-from <md>] [--tag <tag>]
//        node scripts/rewrite-pack-links.mjs <pkg-dir> --restore
//
// The tag is the release run's own: --tag or TELO_PACK_LINKS_TAG (the Publish run
// sets it before publishing — `v<cli version>`, or `packages-<x.y>-<n>`). A local
// pack outside a release names no tag, so its links point at `main` and a note says
// so. A tracked file is backed up before it is
// rewritten and put back by --restore, so the working tree is left as it was; an
// untracked one (a README copied in by prepack) is removed by postpack.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { rewriteMarkdownLinks } = require("./repo-links.cjs");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP = "node_modules/.telo-pack-links";
const SKIP = new Set(["node_modules", ".git"]);

function flag(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function tracked(file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", file], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function posix(path) {
  return path.split(sep).join("/");
}

const [pkgArg, ...rest] = process.argv.slice(2);
if (!pkgArg) {
  console.error("rewrite-pack-links: usage: <pkg-dir> [--restore] [--readme-from <md>] [--tag <tag>]");
  process.exit(1);
}
const pkgDir = resolve(pkgArg);
const backupDir = join(pkgDir, BACKUP);

if (rest.includes("--restore")) {
  if (existsSync(backupDir)) {
    for (const file of markdownFiles(backupDir)) {
      const target = join(pkgDir, relative(backupDir, file));
      copyFileSync(file, target);
    }
    rmSync(backupDir, { recursive: true, force: true });
  }
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const given = flag(rest, "--tag") ?? process.env.TELO_PACK_LINKS_TAG;
if (!given) console.log("rewrite-pack-links: no release tag given (TELO_PACK_LINKS_TAG); a local pack links to main.");
const tag = given || "main";
const readmeFrom = flag(rest, "--readme-from");
const readme = join(pkgDir, "README.md");

let rewritten = 0;
for (const file of markdownFiles(pkgDir)) {
  if (file.startsWith(backupDir)) continue;
  const origin = file === readme && readmeFrom ? resolve(pkgDir, readmeFrom) : file;
  const fromDir = posix(relative(repoRoot, dirname(origin)));
  const before = readFileSync(file, "utf8");
  const after = rewriteMarkdownLinks(before, { repoRoot, fromDir, tag });
  if (after === before) continue;
  if (tracked(file)) {
    const saved = join(backupDir, relative(pkgDir, file));
    mkdirSync(dirname(saved), { recursive: true });
    copyFileSync(file, saved);
  }
  writeFileSync(file, after);
  rewritten += 1;
}
console.log(`rewrite-pack-links: ${pkg.name} → ${rewritten} file(s) rewritten to ${tag}`);
