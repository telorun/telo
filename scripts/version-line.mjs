#!/usr/bin/env node
// The telo version line: the runtime packages that share one version.
//
// It is the changesets `fixed` group containing `@telorun/analyzer` — sdk,
// templating, analyzer, kernel, cli, ide-support, language-server. A package
// belongs to it exactly when its content is bound to one telo generation, so a
// changeset naming any member releases every member at the same version, and
// that version IS the surface generation a module's `requires.telo` range is
// written against (`generate-telo-version.mjs`).
//
// The Rust half of the polyglot runtime is part of the same artifact: every crate
// beneath `<x>/rust/` (the directory's own and every nested one) whose Node twin
// `<x>/nodejs` is on the line carries its twin's version. Derived from the layout
// the repo already mandates (the Rust tree mirrors the Node one) rather than
// listed, so a new twin joins by existing. `telorun-abi` (`sdk/rust/abi`) is the
// only exception — it is versioned by the ABI generation its consumers name — and
// is never touched.
//
// Run as the version step, right after `changeset version` (root
// `version-packages`): it writes each twin's Node version into its
// `Cargo.toml` and into its entry in the `Cargo.lock` governing it (its own, else
// the nearest above), the way `telo release apply` moves a module crate — a
// lockfile left behind makes every `cargo --locked` invocation re-resolve over the
// network, which `--locked` forbids. That lockfile must record the crate exactly
// once as a path package. `check-changeset-status.mjs` imports
// `rustTwinMismatches` to fail a PR whose twins disagree or whose lockfile cannot
// be moved with them.
//
// Both files are rewritten by scanning for the one scalar and splicing over it,
// not by re-serializing: TOML is not parsed here for one value, and the shape
// addressed is the canonical one cargo writes.
//
// Usage: node scripts/version-line.mjs

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINE_ANCHOR = "@telorun/analyzer";
const ABI_CRATE_DIR = join(ROOT, "sdk", "rust", "abi");

/** Member names of the telo version line, from `.changeset/config.json`. Throws
 *  when the analyzer is in no `fixed` group — there is then no line. */
export function versionLineMembers() {
  const configPath = join(ROOT, ".changeset", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const group = (config.fixed ?? []).find(
    (candidate) => Array.isArray(candidate) && candidate.includes(LINE_ANCHOR),
  );
  if (!group) {
    throw new Error(
      `${LINE_ANCHOR} is in no \`fixed\` group of .changeset/config.json. The telo version line ` +
        `is that group — the runtime packages (sdk, templating, analyzer, kernel, cli, ` +
        `ide-support, language-server) released together at one version. Restore it; without ` +
        `it there is no single number a module's \`requires.telo\` range is compared against.`,
    );
  }
  return group;
}

/** Every workspace package as `name -> { dir, version }`. `pnpm-workspace.yaml`'s
 *  patterns are literal segments and `*`, expanded by hand so this costs no
 *  pnpm spawn on every install. */
export function workspacePackages() {
  // A Windows checkout with `core.autocrlf` writes CRLF, which `.` does not cross.
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").replace(/\r\n/g, "\n");
  const block = /^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n)*)/m.exec(text);
  const patterns = (block?.[1] ?? "")
    .split("\n")
    .map((line) => /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line)?.[1])
    .filter(Boolean);

  const byName = new Map();
  const expand = (dir, segments) => {
    if (segments.length === 0) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
        if (name) byName.set(name, { dir, version });
      }
      return;
    }
    const [head, ...rest] = segments;
    if (head !== "*") {
      const next = join(dir, head);
      if (existsSync(next)) expand(next, rest);
      return;
    }
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const next = join(dir, entry);
      if (statSync(next).isDirectory()) expand(next, rest);
    }
  };
  for (const pattern of patterns) expand(ROOT, pattern.split("/"));
  return byName;
}

/** `[package]`'s body in a `Cargo.toml`: its span and text. */
function packageTable(text) {
  const table = /^[ \t]*\[package\][ \t]*$/m.exec(text);
  if (!table) return undefined;
  const start = table.index + table[0].length;
  const next = /^[ \t]*\[/m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return { start, body: text.slice(start, end) };
}

function crateField(text, field, where) {
  const table = packageTable(text);
  const match = table && new RegExp(`^[ \\t]*${field}[ \\t]*=[ \\t]*"(.*?)"[ \\t]*$`, "m").exec(table.body);
  if (!match) throw new Error(`${where}: [package].${field} is not a quoted scalar on one line.`);
  return match[1];
}

/** Every crate directory at or beneath `dir`, skipping build output and the ABI
 *  crate. */
function crateDirs(dir) {
  if (dir === ABI_CRATE_DIR) return [];
  const found = existsSync(join(dir, "Cargo.toml")) ? [dir] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "target" || entry.name.startsWith(".")) continue;
    found.push(...crateDirs(join(dir, entry.name)));
  }
  return found;
}

/** Every Rust twin of a line member: `{ pkg, nodeVersion, crateDir, crate,
 *  crateVersion }`. */
export function rustTwins(packages = workspacePackages()) {
  const twins = [];
  for (const name of versionLineMembers()) {
    const pkg = packages.get(name);
    if (!pkg) continue;
    const rustDir = join(dirname(pkg.dir), "rust");
    if (!existsSync(rustDir)) continue;
    for (const crateDir of crateDirs(rustDir)) {
      const manifest = join(crateDir, "Cargo.toml");
      const text = readFileSync(manifest, "utf8");
      const where = relative(ROOT, manifest);
      twins.push({
        pkg: name,
        nodeVersion: pkg.version,
        crateDir,
        crate: crateField(text, "name", where),
        crateVersion: crateField(text, "version", where),
      });
    }
  }
  return twins;
}

/** The `Cargo.lock` governing `crateDir` — its own, else the nearest one above
 *  it, never past the repository root. */
function governingLock(crateDir) {
  for (let dir = crateDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "Cargo.lock");
    if (existsSync(candidate)) return candidate;
    if (dir === ROOT || dirname(dir) === dir) return undefined;
  }
}

/** The version scalar of every PATH package `crate` in a `Cargo.lock` — a
 *  workspace member carries no `source`, while a registry package of the same
 *  name is another crate. */
function lockRecords(text, crate, where) {
  const headers = /^\[\[package\]\][ \t]*$/gm;
  const records = [];
  for (let header = headers.exec(text); header; header = headers.exec(text)) {
    const start = header.index + header[0].length;
    const next = /^[ \t]*\[/m.exec(text.slice(start));
    const body = text.slice(start, next ? start + next.index : text.length);
    if (/^[ \t]*name[ \t]*=[ \t]*"(.*?)"[ \t]*$/m.exec(body)?.[1] !== crate) continue;
    if (/^[ \t]*source[ \t]*=/m.test(body)) continue;
    const entry = /^([ \t]*version[ \t]*=[ \t]*)"(.*?)"[ \t]*$/m.exec(body);
    if (!entry) throw new Error(`${where}: '${crate}' records no version that can be rewritten.`);
    records.push({ at: start + entry.index + entry[1].length, length: entry[2].length + 2 });
  }
  return records;
}

/** Each twin with its governing lockfile, every lockfile read once:
 *  `{ twin, lock, records, problem }`, `problem` a human message or undefined. */
function resolveTwinLocks(twins, lockTexts = new Map()) {
  return twins.map((twin) => {
    const dir = relative(ROOT, twin.crateDir);
    const lock = governingLock(twin.crateDir);
    if (!lock) {
      return {
        twin,
        problem:
          `No \`Cargo.lock\` governs \`${dir}/Cargo.toml\` between it and the repository root, ` +
          `so the crate's version cannot be moved with it. Make the crate a member of the root ` +
          `workspace, or commit a \`Cargo.lock\` for its own workspace.`,
      };
    }
    if (!lockTexts.has(lock)) lockTexts.set(lock, readFileSync(lock, "utf8"));
    const where = relative(ROOT, lock);
    const records = lockRecords(lockTexts.get(lock), twin.crate, where);
    let problem;
    if (records.length === 0) {
      problem =
        `\`${where}\` does not record '${twin.crate}' (\`${dir}/Cargo.toml\`) as a path package, ` +
        `so the crate's version cannot be moved in the lockfile that governs it. \`${where}\` is ` +
        `the nearest \`Cargo.lock\` above the crate: make the crate a member of the workspace ` +
        `that lockfile belongs to, or give the crate a \`[workspace]\` of its own and commit its ` +
        `own \`Cargo.lock\` (\`cargo generate-lockfile\` in \`${dir}\`).`;
    } else if (records.length > 1) {
      problem =
        `\`${where}\` records '${twin.crate}' ${records.length} times as a path package, so which ` +
        `entry is \`${dir}/Cargo.toml\` cannot be decided.`;
    }
    return { twin, lock, records, problem };
  });
}

/** Twins whose crate version is not their Node twin's, and twins whose governing
 *  lockfile cannot be moved with them, as human messages. */
export function rustTwinMismatches(packages) {
  const messages = [];
  for (const { twin, problem } of resolveTwinLocks(rustTwins(packages))) {
    if (twin.crateVersion !== twin.nodeVersion) {
      messages.push(
        `${relative(ROOT, join(twin.crateDir, "Cargo.toml"))} is ${twin.crateVersion} but its Node ` +
          `twin ${twin.pkg} is ${twin.nodeVersion}. The two halves are one artifact — run ` +
          `\`node scripts/version-line.mjs\` to write the Node version into the crate and ` +
          `Cargo.lock.`,
      );
    }
    if (problem) messages.push(problem);
  }
  return messages;
}

function stampCrate(text, version, where) {
  const table = packageTable(text);
  const entry = table && /^([ \t]*version[ \t]*=[ \t]*)"(.*?)"[ \t]*$/m.exec(table.body);
  if (!entry) throw new Error(`${where}: [package].version is not a quoted scalar on one line.`);
  const start = table.start + entry.index + entry[1].length;
  return `${text.slice(0, start)}"${version}"${text.slice(start + entry[2].length + 2)}`;
}

/** Write every twin's Node version into its crate and its governing lockfile.
 *  Every twin is checked before anything is written. */
export function stampRustTwins() {
  const lockTexts = new Map();
  const resolved = resolveTwinLocks(rustTwins(), lockTexts);
  const problems = resolved.map(({ problem }) => problem).filter(Boolean);
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const crates = [];
  const lockEdits = new Map();
  for (const { twin, lock, records } of resolved) {
    const manifest = join(twin.crateDir, "Cargo.toml");
    const where = relative(ROOT, manifest);
    const before = readFileSync(manifest, "utf8");
    const after = stampCrate(before, twin.nodeVersion, where);
    if (after !== before) crates.push({ manifest, after, note: `${where} → ${twin.nodeVersion}` });
    const [{ at, length }] = records;
    if (!lockEdits.has(lock)) lockEdits.set(lock, []);
    lockEdits.get(lock).push({ at, length, version: twin.nodeVersion });
  }

  for (const { manifest, after } of crates) writeFileSync(manifest, after);
  for (const [lock, edits] of lockEdits) {
    let text = lockTexts.get(lock);
    for (const { at, length, version } of edits.sort((a, b) => b.at - a.at)) {
      text = `${text.slice(0, at)}"${version}"${text.slice(at + length)}`;
    }
    if (text !== lockTexts.get(lock)) writeFileSync(lock, text);
  }
  return crates.map(({ note }) => note);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const written = stampRustTwins();
    console.log(
      written.length > 0
        ? `version-line: ${written.join(", ")}`
        : "version-line: every Rust twin already carries its Node twin's version.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n")) console.error(`version-line: ${line}`);
    process.exit(1);
  }
}
