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
// The Rust half of the polyglot runtime is part of the same artifact: a crate at
// `<x>/rust` whose Node twin `<x>/nodejs` is on the line carries its twin's
// version. Derived from the layout the repo already mandates (the Rust tree
// mirrors the Node one) rather than listed, so a new twin joins by existing.
// `telorun-abi` (`sdk/rust/abi`) is not a twin — it is versioned by the ABI
// generation its consumers name — and is never touched.
//
// Run as the version step, right after `changeset version` (root
// `version-packages`): it writes each twin's Node version into its
// `Cargo.toml` and into the root `Cargo.lock` entry recording it, the way
// `telo release apply` moves a module crate — a lockfile left behind makes every
// `cargo --locked` invocation re-resolve over the network, which `--locked`
// forbids. `check-changeset-status.mjs` imports `rustTwinMismatches` to fail a PR
// whose twins disagree.
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
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
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

/** Every Rust twin of a line member: `{ pkg, nodeVersion, crateDir, crate,
 *  crateVersion }`. */
export function rustTwins(packages = workspacePackages()) {
  const twins = [];
  for (const name of versionLineMembers()) {
    const pkg = packages.get(name);
    if (!pkg) continue;
    const crateDir = join(dirname(pkg.dir), "rust");
    const manifest = join(crateDir, "Cargo.toml");
    if (!existsSync(manifest)) continue;
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
  return twins;
}

/** Twins whose crate version is not their Node twin's, as human messages. */
export function rustTwinMismatches(packages) {
  return rustTwins(packages)
    .filter((twin) => twin.crateVersion !== twin.nodeVersion)
    .map(
      (twin) =>
        `${relative(ROOT, join(twin.crateDir, "Cargo.toml"))} is ${twin.crateVersion} but its Node ` +
        `twin ${twin.pkg} is ${twin.nodeVersion}. The two halves are one artifact — run ` +
        `\`node scripts/version-line.mjs\` to write the Node version into the crate and ` +
        `Cargo.lock.`,
    );
}

function stampCrate(text, version, where) {
  const table = packageTable(text);
  const entry = table && /^([ \t]*version[ \t]*=[ \t]*)"(.*?)"[ \t]*$/m.exec(table.body);
  if (!entry) throw new Error(`${where}: [package].version is not a quoted scalar on one line.`);
  const start = table.start + entry.index + entry[1].length;
  return `${text.slice(0, start)}"${version}"${text.slice(start + entry[2].length + 2)}`;
}

/** The PATH package `crate`'s version in a `Cargo.lock` — a workspace member
 *  carries no `source`, while a registry package of the same name is another
 *  crate. */
function stampLock(text, crate, version, where) {
  const headers = /^\[\[package\]\][ \t]*$/gm;
  const edits = [];
  for (let header = headers.exec(text); header; header = headers.exec(text)) {
    const start = header.index + header[0].length;
    const next = /^[ \t]*\[/m.exec(text.slice(start));
    const body = text.slice(start, next ? start + next.index : text.length);
    if (/^[ \t]*name[ \t]*=[ \t]*"(.*?)"[ \t]*$/m.exec(body)?.[1] !== crate) continue;
    if (/^[ \t]*source[ \t]*=/m.test(body)) continue;
    const entry = /^([ \t]*version[ \t]*=[ \t]*)"(.*?)"[ \t]*$/m.exec(body);
    if (!entry) throw new Error(`${where}: '${crate}' records no version that can be rewritten.`);
    edits.push({ at: start + entry.index + entry[1].length, length: entry[2].length + 2 });
  }
  if (edits.length !== 1) {
    throw new Error(
      `${where}: '${crate}' is recorded ${edits.length} times as a path package where exactly ` +
        `one entry is the workspace member, so the lockfile cannot be moved with the crate.`,
    );
  }
  const [{ at, length }] = edits;
  return `${text.slice(0, at)}"${version}"${text.slice(at + length)}`;
}

/** Write every twin's Node version into its crate and the root lockfile. */
export function stampRustTwins() {
  const lockPath = join(ROOT, "Cargo.lock");
  let lock = readFileSync(lockPath, "utf8");
  const written = [];
  for (const twin of rustTwins()) {
    const manifest = join(twin.crateDir, "Cargo.toml");
    const where = relative(ROOT, manifest);
    const before = readFileSync(manifest, "utf8");
    const after = stampCrate(before, twin.nodeVersion, where);
    if (after !== before) writeFileSync(manifest, after);
    lock = stampLock(lock, twin.crate, twin.nodeVersion, "Cargo.lock");
    if (after !== before) written.push(`${where} → ${twin.nodeVersion}`);
  }
  writeFileSync(lockPath, lock);
  return written;
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
    console.error(`version-line: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
