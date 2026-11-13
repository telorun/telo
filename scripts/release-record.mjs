#!/usr/bin/env bun
// The record of a release on main: what main must hold of a published release tag,
// written as one generated commit instead of merging the branch's history.
//
// From the tag's release commit (`release-commit.mjs`: the commit it points at, or the
// parent of the publication commit it points at, so no pinned import is read) it copies,
// for every release unit main's `telo-workspace.yaml` names, the unit's version into
// every version location of it — each anchor's `package.json`, `Cargo.toml` (and its
// `Cargo.lock` entry), `Chart.yaml` or `telo.yaml`, and a module manifest's own npm
// pins — its `CHANGELOG.md` and its `.changes/ledger.yaml` entry; and it deletes each
// fragment the tag released (`carried-changes.ts`). Floors are computed afterwards by
// the workflow (`telo release floor`), never copied; imports stay relative on main, so
// no pin is written. Every write goes through the release package's own stamps.
//
// One floor is taken from the tag rather than computed, because measurement cannot: a
// `>=unreleased` in a module's `requires.telo` or `restrictions:` entry that the release
// resolved on its branch (`telo release apply`) becomes the bound the tag holds at the same place.
// A `restrictions:` entry is invisible to `telo release floor`, and left at `>=unreleased` in a
// dependency it holds every dependent's measured floor there through its import closure.
//
// Two modes over one computation: `write` (Record release) writes the files; `check`
// (Start release candidates) writes nothing and refuses when any file would change,
// naming the first. Main records a tag exactly when `check` finds nothing.
//
// Runs under bun, which reads the analyzer and the CLI's release modules from source.
//
// Usage:
//   pnpm exec bun scripts/release-record.mjs write --tag <tag>
//   pnpm exec bun scripts/release-record.mjs check --tag <tag>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import { stampSelfNpmPins, teloLegacyLedgerLayers } from "../analyzer/nodejs/src/release/index.ts";
import {
  LEDGER_PATH,
  layerDigests,
  parseLedger,
  readUnitVersions,
  serializeLedger,
  stampUnitVersion,
} from "../release/nodejs/src/index.ts";
import { releasedBy } from "../release/nodejs/src/node/carried-changes.ts";
import { loadWorkspaceFor } from "../release/nodejs/src/node/operations.ts";
import { WorkspaceNotFoundError } from "../release/nodejs/src/node/workspace.ts";
import { teloReleaseHost } from "../cli/nodejs/src/release/telo-host.ts";
import { refuse, setOutput } from "./release-actions-output.mjs";
import { recordTagFor } from "./release-branch.mjs";
import { releaseCommitOf } from "./release-commit.mjs";
import { ROOT } from "./version-line.mjs";


/**
 * `text` with each `>=unreleased` in `requires.telo` and in a `restrictions:` entry's
 * `requires.telo` replaced by the bound `taggedText` — the same module as a release
 * resolved it — holds at the same place: `requires.telo`, or the entry of the same index
 * and `reason`. A place the release left `>=unreleased`, or that has no counterpart, stays.
 */
function carryResolvedFloors(text, taggedText) {
  const ownerOf = (source) =>
    parseAllDocuments(source).find((doc) => {
      const kind = doc.get("kind");
      return kind === "Telo.Application" || kind === "Telo.Library";
    });
  const own = ownerOf(text);
  const tagged = ownerOf(taggedText);
  if (!own || !tagged || !isMap(own.contents) || !isMap(tagged.contents)) return { text, changes: [] };
  const edits = [];
  const consider = (requires, taggedRequires, where) => {
    if (!isMap(requires) || !isMap(taggedRequires)) return;
    const node = requires.get("telo", true);
    const resolved = taggedRequires.get("telo");
    if (!isScalar(node) || node.value !== ">=unreleased" || !node.range) return;
    if (typeof resolved !== "string" || resolved === ">=unreleased") return;
    const [start, end] = node.range;
    const quote = /^['"]/.exec(text.slice(start, end))?.[0] ?? "";
    edits.push({ start, end, text: `${quote}${resolved}${quote}`, where });
  };
  consider(own.contents.get("requires", true), tagged.contents.get("requires", true), "requires.telo");
  const restrictions = own.contents.get("restrictions", true);
  const taggedRestrictions = tagged.contents.get("restrictions", true);
  if (isSeq(restrictions) && isSeq(taggedRestrictions)) {
    restrictions.items.forEach((entry, index) => {
      const other = taggedRestrictions.items[index];
      if (!isMap(entry) || !isMap(other) || entry.get("reason") !== other.get("reason")) return;
      consider(entry.get("requires", true), other.get("requires", true), `restrictions[${index}].requires.telo`);
    });
  }
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { text: out, changes: edits.sort((a, b) => a.start - b.start).map((edit) => edit.where) };
}

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

/** Main's release workspace, or none when it declares none. */
function releaseWorkspace(root) {
  try {
    return loadWorkspaceFor(teloReleaseHost(), root);
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return undefined;
    throw error;
  }
}

/** The fragments of main's working tree. */
function changeFiles(root) {
  const dir = ".changes/pending";
  return existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((name) => !name.startsWith(".")).map((name) => `${dir}/${name}`)
    : [];
}

function sameEntry(a, b) {
  const canonical = (entry) =>
    entry &&
    JSON.stringify([
      entry.version,
      entry.registry ?? "",
      layerDigests(entry.layers),
      entry.candidate ? [entry.candidate.version, layerDigests(entry.candidate.layers)] : null,
    ]);
  return canonical(a) === canonical(b);
}

/**
 * What recording `tag` changes in main's tree (the checkout): `writes` (each file's
 * new text, only where it differs) and `deletions`. Everything is read at the tag's
 * release commit.
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
  const workspace = releaseWorkspace(root);
  const units = workspace?.units ?? [];
  for (const unit of units) {
    const version = readUnitVersions(unit, textAt, workspace.adapters).find((reading) => reading.value)?.value;
    if (!version) continue;
    for (const { file, text } of stampUnitVersion(unit, version, current, workspace.adapters)) put(file, text);
    for (const location of unit.versionLocations) {
      const handler = workspace.adapters.handlerFor(location.file.slice(location.file.lastIndexOf("/") + 1));
      for (const companion of handler?.companions?.(location.file, version, current) ?? []) put(companion.file, companion.text);
    }
    // A module delivering its controller from npm pins its own package in its manifest.
    const manifest = `${unit.dir}/telo.yaml`;
    if (!unit.anchors.some((anchor) => anchor.ecosystem === "telo") || current(manifest) === undefined) continue;
    for (const location of unit.versionLocations) {
      if (!location.file.endsWith("/package.json")) continue;
      const pkg = JSON.parse(current(location.file));
      if (!pkg.private && pkg.name) put(manifest, stampSelfNpmPins(current(manifest), pkg.name, version, manifest));
    }
    const taggedManifest = textAt(manifest);
    if (taggedManifest !== undefined) put(manifest, carryResolvedFloors(current(manifest), taggedManifest).text);
  }
  const unitDirs = new Set(units.map((unit) => unit.dir));
  for (const file of tagged) {
    if (!/(^|\/)CHANGELOG\.md$/.test(file)) continue;
    if (!unitDirs.has(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "")) continue;
    const text = textAt(file);
    if (text !== current(file)) put(file, text);
  }
  const taggedLedger = textAt(LEDGER_PATH);
  if (taggedLedger !== undefined) {
    const keys = new Set(units.map((unit) => unit.key));
    const ours = current(LEDGER_PATH);
    const options = { legacyLayers: teloLegacyLedgerLayers };
    const entries = new Map(ours === undefined ? [] : parseLedger(ours, LEDGER_PATH, options).units);
    let changed = false;
    for (const [key, entry] of parseLedger(taggedLedger, `${tag}:${LEDGER_PATH}`, options).units) {
      if (!keys.has(key) || sameEntry(entries.get(key), entry)) continue;
      entries.set(key, entry);
      changed = true;
    }
    if (changed) put(LEDGER_PATH, serializeLedger({ units: entries }));
  }
  const deletions = [...releasedBy({ cwd: root, files: changeFiles(root), ref: release })].sort();
  const writes = [...files]
    .filter(([, { before, after }]) => before !== after)
    .map(([path, { after }]) => ({ path, text: after }));
  return { writes, deletions };
}

/** The first thing recording `tag` would change in main's tree, or undefined when
 *  main records it. Writes nothing. */
export function recordDifference({ tag }) {
  const { writes, deletions } = recordPlan({ tag });
  if (writes.length > 0) return writes[0].path;
  return deletions[0];
}

/** Write the record of `tag`. */
export function writeRecord({ tag }) {
  const root = ROOT;
  const { writes, deletions } = recordPlan({ tag });
  for (const { path, text } of writes) writeFileSync(join(root, path), text);
  for (const path of deletions) rmSync(join(root, path));
  return { written: writes.map(({ path }) => path), deleted: deletions };
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
      const { written, deleted } = writeRecord({ tag });
      for (const path of written) console.log(`release-record: ${path} ← ${tag}`);
      for (const path of deleted) console.log(`release-record: ${path} deleted (released by ${tag})`);
      setOutput("tag", tag);
      setOutput("branch", `release-record/${branch}`);
      setOutput("title", `chore(release): record ${tag} on main`);
    }
  } catch (error) {
    console.error(`::error::release-record: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
