#!/usr/bin/env node
// Run from a published package's `prepack` / `postpack` hooks (and the VS Code
// extension's packaging). A relative link in source resolves against whatever ref
// is being viewed; in a tarball it resolves against nothing, so the markdown that
// ships is rewritten to the tag of the version being published.
//
// Usage: node scripts/rewrite-pack-links.mjs <pkg-dir> [--readme-from <md>]
//        node scripts/rewrite-pack-links.mjs <pkg-dir> --restore
//
// The tag is the release unit's own, `<unit key>@<version>`, which `telo release
// tag` places on the release commit — derived from the package alone, so every
// pack of one version writes the same bytes and the planner's digest of a pack
// equals the published tarball's. The unit is found through `@telorun/release`'s
// own marker reader (its built dist, with the telo ecosystem the analyzer's built
// dist serves), the version is the one the unit records. A tracked file is backed
// up before it is rewritten and put back by --restore, so the working tree is
// left as it was; an untracked one (a README copied in by prepack) is removed by
// postpack.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * `<unit key>@<version>` of the release unit that ships `dir`: the unit whose
 * directory is `dir` or one of its anchors' is. Only the marker entries that can
 * claim it are resolved — a unit's directory is an ancestor of `dir` and its
 * anchors lie beneath that directory — so a pack does not read every module.
 */
async function unitTag(dir) {
  const imported = async (relativePath) => import(pathToFileURL(join(repoRoot, relativePath)).href);
  let release, releaseNode, analyzer;
  try {
    [release, releaseNode, analyzer] = await Promise.all([
      imported("release/nodejs/dist/index.js"),
      imported("release/nodejs/dist/node/index.js"),
      imported("analyzer/nodejs/dist/index.js"),
    ]);
  } catch (error) {
    throw new Error(
      `the release unit is read through @telorun/release and @telorun/analyzer's built dist, which could not be ` +
        `loaded (${error instanceof Error ? error.message : String(error)}). Build them before packing.`,
    );
  }
  const root = releaseNode.findWorkspaceRoot(dir);
  if (!root) throw new Error(`no telo-workspace.yaml above ${dir} names its release unit.`);
  const key = posix(relative(root, dir));
  const ancestors = key.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const directories = new Set();
  for (const ancestor of ancestors) {
    directories.add(ancestor);
    for (const below of releaseNode.directoriesUnder(join(root, ancestor))) directories.add(`${ancestor}/${below}`);
  }
  const settings = release.requireReleaseSettings(
    release.readReleaseMarker(readFileSync(join(root, "telo-workspace.yaml"), "utf8"), "telo-workspace.yaml", analyzer.TELO_RELEASE_ADAPTERS),
    "telo-workspace.yaml",
  );
  const adapters = new release.AdapterRegistry(analyzer.TELO_RELEASE_ADAPTERS);
  const tree = releaseNode.workspaceTree(root, [...directories]);
  const unit = release
    .resolveUnits(settings, tree, adapters)
    .units.find((candidate) => candidate.dir === key || candidate.anchors.some((anchor) => anchor.dir === key));
  if (!unit) throw new Error(`no release unit of telo-workspace.yaml ships ${key}, so its links name no release tag.`);
  const version = release.readUnitVersions(unit, tree.readFile, adapters)[0]?.value;
  if (!version) throw new Error(`release unit ${unit.key} records no version, so its links name no release tag.`);
  return `${unit.key}@${version}`;
}

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
let tag;
try {
  tag = await unitTag(pkgDir);
} catch (error) {
  console.error(`rewrite-pack-links: ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
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
