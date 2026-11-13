/**
 * The `cargo` ecosystem's pure half: an anchor holding a `Cargo.toml` with a
 * `[package]` table is one crate — never the crates beneath it. Its version is
 * `[package].version`, and the `Cargo.lock` recording the crate moves with it.
 */

import type { EcosystemAdapter, VersionFileHandler } from "../adapter.js";
import { VersionFileError, spliceText, tomlString } from "../version-files.js";

export const CARGO_TOML = "Cargo.toml";

/** `[package].name` of a `Cargo.toml`, or `undefined` when it declares no package. */
export function readCrateName(text: string): string | undefined {
  return tomlString(text, ["package", "name"], CARGO_TOML)?.value;
}

/**
 * `version` in a `Cargo.toml`'s `[package]` table, rewritten in place. A
 * `[package]` with `version.workspace = true` inherits and has nothing here to
 * stamp; a version in any other shape is refused rather than left behind.
 */
export function stampCrateVersion(text: string, version: string, where: string): string | undefined {
  const table = /^[ \t]*\[package\][ \t]*$/m.exec(text);
  if (!table) return undefined;
  const bodyStart = table.index + table[0].length;
  const next = /^[ \t]*\[/m.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);

  const entry = /^([ \t]*version[ \t]*=[ \t]*)(".*?"|'.*?')[ \t]*$/m.exec(body);
  if (!entry) {
    if (/^[ \t]*version[ \t]*\.[ \t]*workspace[ \t]*=/m.test(body)) return undefined;
    if (/^[ \t]*version[ \t]*=/m.test(body)) {
      throw new VersionFileError(
        `${where}: [package].version is not a quoted scalar on one line, so it cannot be ` +
          `rewritten in place.`,
      );
    }
    return undefined;
  }

  const start = bodyStart + entry.index + entry[1]!.length;
  const quote = entry[2]![0]!;
  return spliceText(text, start, start + entry[2]!.length, `${quote}${version}${quote}`);
}

/**
 * A workspace member's `version` in the `Cargo.lock` that governs it. A lockfile
 * left behind makes every `cargo --locked` re-resolve, which `--locked`
 * forbids. Only a PATH package (no `source`) is addressed; a name recorded more
 * than once as one is refused rather than guessed at.
 */
export function stampLockedCrateVersion(
  text: string,
  crate: string,
  version: string,
  where: string,
): string | undefined {
  const headers = /^\[\[package\]\][ \t]*$/gm;
  const edits: { start: number; end: number }[] = [];

  for (let header = headers.exec(text); header; header = headers.exec(text)) {
    const bodyStart = header.index + header[0].length;
    const next = /^[ \t]*\[/m.exec(text.slice(bodyStart));
    const bodyEnd = next ? bodyStart + next.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);

    if (/^[ \t]*name[ \t]*=[ \t]*"(.*?)"[ \t]*$/m.exec(body)?.[1] !== crate) continue;
    if (/^[ \t]*source[ \t]*=/m.test(body)) continue;

    const entry = /^([ \t]*version[ \t]*=[ \t]*)(".*?")[ \t]*$/m.exec(body);
    if (!entry) {
      throw new VersionFileError(
        `${where}: the '${crate}' package records no version that can be rewritten in place, ` +
          `so the lockfile would keep naming a version of it that no longer exists.`,
      );
    }
    const start = bodyStart + entry.index + entry[1]!.length;
    edits.push({ start, end: start + entry[2]!.length });
  }

  if (edits.length === 0) return undefined;
  if (edits.length > 1) {
    throw new VersionFileError(
      `${where}: '${crate}' is recorded ${edits.length} times as a path package, so which entry ` +
        `is the workspace member cannot be decided.`,
    );
  }
  return spliceText(text, edits[0]!.start, edits[0]!.end, `"${version}"`);
}

/** The `Cargo.lock` governing a crate: its own, else the nearest one above it,
 *  never past the workspace. */
export function governingLockfile(crateDir: string, read: (path: string) => string | undefined): string | undefined {
  const segments = crateDir === "" ? [] : crateDir.split("/");
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = segments.slice(0, depth).join("/");
    const file = dir === "" ? CARGO_LOCK : `${dir}/${CARGO_LOCK}`;
    if (read(file) !== undefined) return file;
  }
  return undefined;
}

export const CARGO_LOCK = "Cargo.lock";

const cargoTomlHandler: VersionFileHandler = {
  fileName: CARGO_TOML,
  read: (text, where) => tomlString(text, ["package", "version"], where)?.value,
  write: stampCrateVersion,
  companions(file, version, read) {
    const text = read(file);
    const name = text === undefined ? undefined : readCrateName(text);
    if (text !== undefined && tomlString(text, ["package", "version"], file) === undefined) return [];
    if (name === undefined) {
      throw new VersionFileError(
        `${file}: [package].name is missing, so the crate's entry in Cargo.lock cannot be ` +
          `addressed and the lockfile would keep naming a version that no longer exists.`,
      );
    }
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const lockfile = governingLockfile(dir, read);
    if (!lockfile) return [];
    const before = read(lockfile)!;
    const after = stampLockedCrateVersion(before, name, version, lockfile);
    return after === undefined || after === before ? [] : [{ file: lockfile, text: after }];
  },
};

export const cargoAdapter: EcosystemAdapter = {
  ecosystem: "cargo",
  anchorDescription: "a directory holding a Cargo.toml with a [package] table",
  versionFile: { file: CARGO_TOML },
  recognize(probe) {
    const text = probe.readFile(CARGO_TOML);
    const name = text === undefined ? undefined : readCrateName(text);
    return name === undefined ? undefined : { name, contributesLayer: true };
  },
  versionFileHandlers: [cargoTomlHandler],
};

const DEPENDENCY_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);
/** A requirement a release may move: an optional operator and a version, whole or partial. */
const PLAIN_REQUIREMENT = /^(\^|~|>=|=)?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;

/** A dotted TOML key split into its segments, quotes removed. */
export function dottedKey(key: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of key.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ".") {
      segments.push(current.trim());
      current = "";
    } else current += char;
  }
  segments.push(current.trim());
  return segments;
}

/** `path/..` segments resolved, `/`-separated and relative to the workspace. */
function normalizedPath(dir: string, relative: string): string {
  const out: string[] = dir === "" ? [] : dir.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/** `key = "…"` inside an inline table body or on a line: the value and its span. */
export function quotedValue(text: string, key: string): { value: string; start: number; end: number } | undefined {
  const match = new RegExp(`(^|[{,\\s])${key}[ \\t]*=[ \\t]*"([^"]*)"`).exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length - match[2]!.length - 2;
  return { value: match[2]!, start, end: start + match[2]!.length + 2 };
}

/**
 * A `Cargo.toml` with the version requirement of every dependency on the crate
 * at `targetDir` rewritten to `version`, keeping its operator — the cargo twin
 * of a dependent's plain npm range. `manifestDir` and `targetDir` are
 * workspace-relative. A dependency is matched by its `path`, in a
 * `[*dependencies]` table's inline entry or in a `[*dependencies.<name>]`
 * table; one with no `version` key, or a requirement that is not one plain
 * version (`>=1, <2`), is left as written.
 */
export function stampPathDependencyRequirements(
  text: string,
  manifestDir: string,
  targetDir: string,
  version: string,
): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const rewrite = (found: { value: string; start: number; end: number } | undefined, at: number) => {
    if (!found) return;
    const plain = PLAIN_REQUIREMENT.exec(found.value);
    if (!plain) return;
    const replacement = `"${plain[1] ?? ""}${version}"`;
    if (replacement !== text.slice(at + found.start, at + found.end)) {
      edits.push({ start: at + found.start, end: at + found.end, text: replacement });
    }
  };
  const targets = (path: string) => normalizedPath(manifestDir, path) === targetDir;

  let section: string[] = [];
  let table: { path?: string; version?: { value: string; start: number; end: number; at: number } } | undefined;
  const closeTable = () => {
    if (table?.path !== undefined && targets(table.path) && table.version) rewrite(table.version, table.version.at);
    table = undefined;
  };
  let offset = 0;
  for (const line of text.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    const header = /^[ \t]*\[([^[\]]+)\][ \t]*(#.*)?\r?$/.exec(line);
    if (header) {
      closeTable();
      section = dottedKey(header[1]!);
      if (section.length >= 2 && DEPENDENCY_TABLES.has(section[section.length - 2]!)) table = {};
      continue;
    }
    if (table) {
      const path = quotedValue(line, "path");
      if (path && /^[ \t]*path[ \t]*=/.test(line)) table.path = path.value;
      const requirement = quotedValue(line, "version");
      if (requirement && /^[ \t]*version[ \t]*=/.test(line)) table.version = { ...requirement, at };
      continue;
    }
    if (!DEPENDENCY_TABLES.has(section[section.length - 1] ?? "")) continue;
    const inline = /^[ \t]*[^=#]+=[ \t]*\{(.*)\}/.exec(line);
    if (!inline) continue;
    const bodyStart = line.indexOf("{") + 1;
    const body = inline[1]!;
    const path = quotedValue(body, "path");
    if (!path || !targets(path.value)) continue;
    rewrite(quotedValue(body, "version"), at + bodyStart);
  }
  closeTable();
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = spliceText(out, edit.start, edit.end, edit.text);
  return out;
}
