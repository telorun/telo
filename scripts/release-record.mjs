#!/usr/bin/env bun
// The record of a release on main: what main must hold of a published release tag,
// written as one generated commit instead of merging the branch's history.
//
// From the tag's release commit (`release-commit.mjs`: the commit it points at, or the
// parent of the publication commit it points at, so no pinned import is read) it copies,
// for every artifact present on main, each package's `version`, each module's version
// (its `telo.yaml`, own npm pins, `nodejs/package.json`,
// `rust/Cargo.toml` and that crate's entry in the governing `Cargo.lock`), every
// `CHANGELOG.md` and every `.changes/ledger.yaml` entry; and it deletes each
// changeset and fragment the tag released (`carried-changes.ts`). Floors
// are computed afterwards by the workflow (`telo release floor`), never copied;
// imports stay relative on main, so no pin is written. Every write goes through the analyzer's own version stamps.
//
// One floor is taken from the tag rather than computed, because measurement cannot: a
// `>=unreleased` in a module's `requires.telo` or `restrictions:` entry that the release
// resolved on its branch (the version step) becomes the bound the tag holds at the same place.
// A `restrictions:` entry is invisible to `telo release floor`, and left at `>=unreleased` in a
// dependency it holds every dependent's measured floor there through its import closure.
//
// Two modes over one computation: `write` (Record release) writes the files, then
// the Rust twins and chart versions that follow from them; `check` (Start release candidates)
// writes nothing and refuses when any file would change, naming the first. Main
// records a tag exactly when `check` finds nothing.
//
// Runs under bun, which reads the analyzer and the CLI's release modules from source.
//
// Usage:
//   pnpm exec bun scripts/release-record.mjs write --tag <tag>
//   pnpm exec bun scripts/release-record.mjs check --tag <tag>

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LEDGER_PATH,
  parseLedger,
  readManifestVersion,
  serializeLedger,
  stampCrateVersion,
  stampLockedCrateVersion,
  stampManifestVersion,
  stampPackageVersion,
  stampSelfNpmPins,
} from "../analyzer/nodejs/src/release/index.ts";
import { parseCargoToml } from "../cli/nodejs/src/release/cargo-toml.ts";
import { releasedBy } from "../cli/nodejs/src/release/carried-changes.ts";
import { WorkspaceNotFoundError, loadWorkspace } from "../cli/nodejs/src/release/workspace.ts";
import { refuse, setOutput } from "./release-actions-output.mjs";
import { recordTagFor } from "./release-branch.mjs";
import { releaseCommitOf } from "./release-commit.mjs";
import { ROOT, carryResolvedFloors, rustTwinMismatches, stampRustTwins, workspacePackages } from "./version-line.mjs";

const posix = (path) => path.split(sep).join("/");

function show(root, rev, path) {
  return execFileSync("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function treeFiles(root, rev) {
  return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", rev], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function workspaceModules(root) {
  try {
    return loadWorkspace(root).modules;
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return [];
    throw error;
  }
}

/** The `Cargo.lock` governing `from`, its own or the nearest above, never past `root`. */
function governingLock(from, root) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "Cargo.lock"))) return join(dir, "Cargo.lock");
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

/** The changesets and fragments of main's working tree. */
function changeFiles(root) {
  const list = (dir, keep) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(keep).map((name) => `${dir}/${name}`) : [];
  return [
    ...list(".changeset", (name) => name.endsWith(".md") && name !== "README.md"),
    ...list(".changes/pending", (name) => !name.startsWith(".")),
  ];
}

function sameEntry(a, b) {
  const canonical = (entry) =>
    entry && JSON.stringify([entry.version, entry.registry ?? "", Object.entries(entry.layers).sort()]);
  return canonical(a) === canonical(b);
}

/**
 * What recording `tag` changes in main's tree (the checkout): `writes` (each file's
 * new text, only where it differs), `deletions`, and `packages` — every workspace
 * package with the version the record gives it, for the Rust twins that follow.
 * Everything is read at the tag's release commit.
 */
export function recordPlan({ tag }) {
  const root = ROOT;
  const release = releaseCommitOf({ cwd: root, tag });
  const tagged = new Set(treeFiles(root, release));
  const textAt = (path) => (tagged.has(path) ? show(root, release, path) : undefined);
  const files = new Map();
  const current = (path) =>
    files.has(path) ? files.get(path).after : existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
  const put = (path, text) => {
    if (text === undefined) return;
    const before = files.has(path) ? files.get(path).before : current(path);
    files.set(path, { before, after: text });
  };

  const packages = new Map();
  const artifactDirs = new Set();
  for (const [name, pkg] of workspacePackages()) {
    const dir = posix(relative(root, pkg.dir));
    const file = `${dir}/package.json`;
    artifactDirs.add(dir);
    packages.set(name, pkg);
    const taggedText = textAt(file);
    if (taggedText === undefined) continue;
    const { name: taggedName, version } = JSON.parse(taggedText);
    if (taggedName !== name || typeof version !== "string") continue;
    packages.set(name, { ...pkg, version });
    put(file, stampPackageVersion(current(file), version, file));
  }

  const modules = workspaceModules(root);
  for (const module of modules) {
    artifactDirs.add(module.key);
    const manifest = `${module.key}/telo.yaml`;
    const taggedManifest = textAt(manifest);
    const version = taggedManifest === undefined ? undefined : readManifestVersion(taggedManifest);
    if (!version) continue;

    const ownPackage = `${module.key}/nodejs/package.json`;
    let text = stampManifestVersion(current(manifest), version, manifest) ?? current(manifest);
    if (current(ownPackage) !== undefined) {
      const pkg = JSON.parse(current(ownPackage));
      if (!pkg.private && pkg.name) text = stampSelfNpmPins(text, pkg.name, version, manifest);
      put(ownPackage, stampPackageVersion(current(ownPackage), version, ownPackage));
    }
    put(manifest, carryResolvedFloors(text, taggedManifest).text);

    const crate = `${module.key}/rust/Cargo.toml`;
    if (current(crate) === undefined) continue;
    put(crate, stampCrateVersion(current(crate), version, crate));
    const name = parseCargoToml(current(crate), crate).package?.name;
    if (typeof name !== "string") throw new Error(`${crate}: [package].name is missing, so its Cargo.lock entry cannot be addressed.`);
    const lock = governingLock(join(root, module.key, "rust"), root);
    if (!lock) continue;
    const lockFile = posix(relative(root, lock));
    put(lockFile, stampLockedCrateVersion(current(lockFile), name, version, lockFile));
  }

  for (const file of tagged) {
    if (!/(^|\/)CHANGELOG\.md$/.test(file)) continue;
    if (!artifactDirs.has(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "")) continue;
    const text = textAt(file);
    if (text !== current(file)) put(file, text);
  }

  const taggedLedger = textAt(LEDGER_PATH);
  if (taggedLedger !== undefined) {
    const keys = new Set(modules.map((module) => module.key));
    const ours = current(LEDGER_PATH);
    const entries = new Map(ours === undefined ? [] : parseLedger(ours, LEDGER_PATH).modules);
    let changed = false;
    for (const [key, entry] of parseLedger(taggedLedger, `${tag}:${LEDGER_PATH}`).modules) {
      if (!keys.has(key) || sameEntry(entries.get(key), entry)) continue;
      entries.set(key, entry);
      changed = true;
    }
    if (changed) put(LEDGER_PATH, serializeLedger({ modules: entries }));
  }

  const deletions = [...releasedBy({ cwd: root, files: changeFiles(root), ref: release })].sort();
  const writes = [...files]
    .filter(([, { before, after }]) => before !== after)
    .map(([path, { after }]) => ({ path, text: after }));
  return { writes, deletions, packages };
}

/** The first thing recording `tag` would change in main's tree, or undefined when
 *  main records it. Writes nothing. */
export function recordDifference({ tag }) {
  const { writes, deletions, packages } = recordPlan({ tag });
  if (writes.length > 0) return writes[0].path;
  if (deletions.length > 0) return deletions[0];
  return rustTwinMismatches(packages)[0];
}

/** Write the record of `tag`: the plan, then the Rust twins and chart versions. */
export function writeRecord({ tag }) {
  const root = ROOT;
  const { writes, deletions } = recordPlan({ tag });
  for (const { path, text } of writes) writeFileSync(join(root, path), text);
  for (const path of deletions) rmSync(join(root, path));
  const twins = stampRustTwins();
  const charts = spawnSync(process.execPath, [join(root, "scripts", "stamp-chart-version.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (charts.status !== 0) throw new Error("stamp-chart-version.mjs failed; see its output above.");
  return { written: writes.map(({ path }) => path), deleted: deletions, twins };
}

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [mode] = process.argv.slice(2);
    if (mode !== "write" && mode !== "check") throw new Error(`unknown mode '${mode ?? ""}'; use write or check.`);
    const given = argument("tag");
    const { tag, branch } = recordTagFor({ given });
    if (tag !== given) console.log(`release-record: ${given} is not ${branch}'s newest release; recording ${tag}.`);
    if (mode === "check") {
      const difference = recordDifference({ tag });
      if (difference) {
        refuse(`Error: main does not record ${tag}: ${difference} differs. Merge "chore(release): record ${tag} on main" first.`);
      }
      console.log(`release-record: main records ${tag}.`);
    } else {
      const { written, deleted, twins } = writeRecord({ tag });
      for (const path of written) console.log(`release-record: ${path} ← ${tag}`);
      for (const path of deleted) console.log(`release-record: ${path} deleted (released by ${tag})`);
      for (const note of twins) console.log(`release-record: ${note}`);
      setOutput("tag", tag);
      setOutput("branch", `release-record/${branch}`);
      setOutput("title", `chore(release): record ${tag} on main`);
    }
  } catch (error) {
    console.error(`::error::release-record: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
