#!/usr/bin/env node
// The telo version line: the runtime packages that share one version.
//
// It is the changesets `fixed` group containing `@telorun/analyzer` — sdk, cel,
// message-format, templating, analyzer, kernel, cli, ide-support, language-server. A package
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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parse, parseAllDocuments } from "yaml";

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

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver precedence of two versions, prerelease included (`0.85.0-rc.1` < `0.85.0`).
 *  Build metadata is not part of a package version and is not read. */
export function compareVersions(a, b) {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const ours = left[4].split(".");
  const theirs = right[4].split(".");
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const [x, y] = [ours[i], theirs[i]];
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Number(x) - Number(y);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return ours.length - theirs.length;
}

/** `major.minor.patch` of a version, prerelease dropped. */
export function releaseTriple(version) {
  return version.split(/[-+]/)[0];
}

/** `.changeset/pre.json` as changesets wrote it, or undefined outside prerelease
 *  mode. `mode` is `pre` while candidates are being cut and `exit` between
 *  `changeset pre exit` and the Version PR that consumes the file. */
export function readPreState() {
  const file = join(ROOT, ".changeset", "pre.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** A `release/*` branch, given as a bare name or as `origin/<name>`. */
export function isReleaseBranch(name) {
  return /^(?:origin\/)?release\/.+/.test(name ?? "");
}

/** Whether a release branch (`release/<major>.<minor>`, or `origin/…`) has published
 *  its first final — `v<major>.<minor>.0` exists. Before it, the branch is fresh or
 *  in candidates; after it, it takes patches only. */
export function finalPublished({ cwd = ROOT, branch }) {
  const match = /^(?:origin\/)?release\/(\d+)\.(\d+)$/.exec(branch);
  if (!match) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  const tags = execFileSync("git", ["tag", "--list", `v${match[1]}.${match[2]}.0`], { cwd, encoding: "utf8" });
  return tags.trim() !== "";
}

/**
 * changesets' own release plan for this tree, `.changeset/pre.json` honoured.
 * Resolved THROUGH `@changesets/cli` rather than added as a dependency of this
 * repo, so it is the same version the CLI itself uses — the two are released
 * together and read the config the same way. Not through the `changeset status`
 * CLI, which diffs against the config's `baseBranch` and fails in a CI checkout
 * that has no local `main`.
 */
export async function readReleasePlan() {
  const here = createRequire(import.meta.url);
  const fromCli = createRequire(here.resolve("@changesets/cli/package.json"));
  // `getReleasePlan` validates the config against the workspace itself and cannot
  // take a trimmed one, so its four steps are run here over `presentConfig`.
  const fromPlan = createRequire(fromCli.resolve("@changesets/get-release-plan"));
  const [assemble, read, pre, config, packagesModule] = await Promise.all([
    import(pathToFileURL(fromPlan.resolve("@changesets/assemble-release-plan")).href),
    import(pathToFileURL(fromPlan.resolve("@changesets/read")).href),
    import(pathToFileURL(fromPlan.resolve("@changesets/pre")).href),
    import(pathToFileURL(fromPlan.resolve("@changesets/config")).href),
    import(pathToFileURL(fromPlan.resolve("@manypkg/get-packages")).href),
  ]);
  // These ship as CJS with an interop default, so importing one yields either the
  // function or a namespace wrapping it depending on the bundle.
  const callable = (module, name) => {
    const found = module.default?.default ?? module.default;
    if (typeof found !== "function") throw new Error(`${name} did not export a callable default`);
    return found;
  };
  const found = await packagesModule.getPackages(ROOT);
  // A changeset naming a package this checkout lacks releases only the rest.
  const present = new Set(found.packages.map((pkg) => pkg.packageJson.name));
  const changesets = (await callable(read, "@changesets/read")(ROOT, undefined))
    .map((changeset) => ({ ...changeset, releases: changeset.releases.filter((release) => present.has(release.name)) }))
    .filter((changeset) => changeset.releases.length > 0);
  const preState = await pre.readPreState(ROOT);
  return callable(assemble, "@changesets/assemble-release-plan")(
    changesets,
    found,
    config.parse(presentConfig(found), found),
    preState,
  );
}

/**
 * `.changeset/config.json` with every package-name list cut to the workspace
 * packages this checkout holds. changesets rejects a name it cannot find, but a
 * partial checkout — the kernel image's build context holds only what the CLI
 * builds from — legitimately lacks most of the ignored modules.
 */
function presentConfig(found) {
  const written = JSON.parse(readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"));
  const present = new Set(found.packages.map((pkg) => pkg.packageJson.name));
  const keep = (names) => names.filter((name) => present.has(name));
  const groups = (list) => (list ?? []).map(keep).filter((group) => group.length > 0);
  return {
    ...written,
    ignore: keep(written.ignore ?? []),
    fixed: groups(written.fixed),
    linked: groups(written.linked),
  };
}

/**
 * The telo generation this tree builds, from changesets' release plan:
 *
 *  - `next`: the version the line moves to when the plan is applied (a candidate's
 *    `0.85.0-rc.1`, an exit's `0.85.0`), or the line's current highest version when
 *    nothing is pending;
 *  - `surface`: `next`'s triple — the manifest generation `requires: telo:` is
 *    checked against, so a candidate reports the release it previews;
 *  - `identity`: `next` as a build of this tree reports itself, with
 *    `+unreleased` while a line release is pending.
 *
 * `generate-telo-version.mjs` writes both; `render-builtin-vocabulary.mjs` stamps
 * `identity` on the archive. One computation, so they can never name different
 * versions. Throws when the line cannot be read.
 */
export async function teloGeneration(packages = workspacePackages()) {
  const members = new Set(versionLineMembers());
  let highest;
  for (const name of members) {
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`the version line names ${name}, which is not a workspace package.`);
    if (typeof pkg.version !== "string" || !VERSION.test(pkg.version)) {
      throw new Error(`${name}'s version '${pkg.version}' is not a semantic version.`);
    }
    if (highest === undefined || compareVersions(pkg.version, highest) > 0) highest = pkg.version;
  }
  const plan = await readReleasePlan();
  let pending;
  for (const release of plan.releases) {
    if (!members.has(release.name) || release.type === "none") continue;
    if (release.newVersion === release.oldVersion) continue;
    if (pending === undefined || compareVersions(release.newVersion, pending.newVersion) > 0) {
      pending = release;
    }
  }
  const next = pending && compareVersions(pending.newVersion, highest) > 0 ? pending.newVersion : highest;
  const unreleased = next !== highest;
  return {
    surface: releaseTriple(next),
    identity: unreleased ? `${next}+unreleased` : next,
    highest,
    next,
    bump: unreleased ? pending.type : undefined,
  };
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

/** Whether a workspace-relative directory matches a `release.modules` pattern:
 *  literal segments and `*` for exactly one. */
function patternMatches(pattern, directory) {
  const parts = pattern.split("/");
  const segments = directory.split("/");
  return parts.length === segments.length && parts.every((part, i) => part === "*" || part === segments[i]);
}

/** The module directories of the release workspace (`telo-workspace.yaml`'s
 *  `release.modules`, last match wins as the CLI reads it), workspace-relative,
 *  each holding a `telo.yaml`. Empty when the repository declares no workspace. */
export function workspaceModuleDirs() {
  const marker = join(ROOT, "telo-workspace.yaml");
  if (!existsSync(marker)) return [];
  const entries = (parse(readFileSync(marker, "utf8"))?.release?.modules ?? []).map((entry) => {
    const text = typeof entry === "string" ? entry : entry.path;
    return text.startsWith("!") ? { negated: true, pattern: text.slice(1) } : { negated: false, pattern: text };
  });
  const candidates = new Set();
  const expand = (dir, segments, prefix) => {
    if (segments.length === 0) {
      if (existsSync(join(dir, "telo.yaml"))) candidates.add(prefix);
      return;
    }
    const [head, ...rest] = segments;
    if (head !== "*") {
      const next = join(dir, head);
      if (existsSync(next)) expand(next, rest, prefix ? `${prefix}/${head}` : head);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      expand(join(dir, entry.name), rest, prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  };
  for (const { negated, pattern } of entries) if (!negated) expand(ROOT, pattern.split("/"), "");
  return [...candidates].sort().filter((directory) => {
    let included = false;
    for (const { negated, pattern } of entries) if (patternMatches(pattern, directory)) included = !negated;
    return included;
  });
}

/**
 * `text` with every `>=unreleased` in `requires.telo` and in a `restrictions:`
 * entry's `requires.telo` replaced by `>=<version>`, spliced into the source so
 * layout, comments and quote style are kept. `changes` names each place.
 */
export function rewriteUnreleasedFloors(text, version) {
  const owner = parseAllDocuments(text).find((doc) => {
    const kind = doc.get("kind");
    return kind === "Telo.Application" || kind === "Telo.Library";
  });
  const edits = [];
  const consider = (requires, where) => {
    if (!isMap(requires)) return;
    const node = requires.get("telo", true);
    if (!isScalar(node) || node.value !== ">=unreleased" || !node.range) return;
    const [start, end] = node.range;
    const quote = /^['"]/.exec(text.slice(start, end))?.[0] ?? "";
    edits.push({ start, end, text: `${quote}>=${version}${quote}`, where });
  };
  if (owner && isMap(owner.contents)) {
    consider(owner.contents.get("requires", true), "requires.telo");
    const restrictions = owner.contents.get("restrictions", true);
    if (isSeq(restrictions)) {
      restrictions.items.forEach((entry, index) => {
        if (isMap(entry)) consider(entry.get("requires", true), `restrictions[${index}].requires.telo`);
      });
    }
  }
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { text: out, changes: edits.sort((a, b) => a.start - b.start).map((edit) => edit.where) };
}

/**
 * `text` with each `>=unreleased` in `requires.telo` and in a `restrictions:` entry's
 * `requires.telo` replaced by the bound `taggedText` — the same module as a release
 * resolved it — holds at the same place: `requires.telo`, or the entry of the same index
 * and `reason`. A place the release left `>=unreleased`, or that has no counterpart, stays.
 */
export function carryResolvedFloors(text, taggedText) {
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

/** Rewrite `>=unreleased` in every workspace module manifest to the surface
 *  version the telo line was just given. Returns one note per rewritten place. */
export async function rewriteWorkspaceFloors() {
  const directories = workspaceModuleDirs();
  if (directories.length === 0) return [];
  const version = releaseTriple((await teloGeneration()).highest);
  const notes = [];
  for (const directory of directories) {
    const file = join(ROOT, directory, "telo.yaml");
    const before = readFileSync(file, "utf8");
    if (!before.includes(">=unreleased")) continue;
    const { text, changes } = rewriteUnreleasedFloors(before, version);
    if (changes.length === 0) continue;
    writeFileSync(file, text);
    for (const where of changes) notes.push(`${directory}/telo.yaml: ${where} >=unreleased → >=${version}`);
  }
  return notes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const written = stampRustTwins();
    console.log(
      written.length > 0
        ? `version-line: ${written.join(", ")}`
        : "version-line: every Rust twin already carries its Node twin's version.",
    );
    for (const note of await rewriteWorkspaceFloors()) console.log(note);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n")) console.error(`version-line: ${line}`);
    process.exit(1);
  }
}
