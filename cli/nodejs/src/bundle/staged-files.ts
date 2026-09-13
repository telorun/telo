/**
 * The files a payload names by declaration rather than by `files:` — `native:`
 * paths, platform-qualified controller `path=`s and `sources:` notices — and
 * whether each can ship as the manifest describes it. The rules are the
 * analyzer's (`stageableFiles`, `unclaimedSourceEntries`), so publish and
 * `telo check` refuse the same modules; what is here is the filesystem half.
 */

import {
  readModuleSources,
  readNativeEntries,
  stageableFiles,
  unclaimedSourceEntries,
  type ModuleFileClaim,
  type ModuleSource,
  type NativeEntry,
  type SourceEntry,
} from "@telorun/analyzer";
import { checkStagedEntry } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { findModuleDoc } from "../commands/manifest-imports.js";

/**
 * The module doc's `native:` entries.
 *
 * An unreadable block is fatal here even though `telo check` reports it too: a
 * `telo release` digest runs no analysis, and an entry skipped at publish would
 * ship an artifact missing a platform's file.
 */
export function readNativeFiles(manifest: string, manifestDir: string): NativeEntry[] {
  const docs = parseAllDocuments(manifest, { customTags: defaultCustomTags() });
  const { entries, problems } = readNativeEntries(findModuleDoc(docs)?.toJSON());
  if (problems.length > 0) {
    throw new Error(
      `Module '${path.basename(manifestDir)}' declares a native: block that cannot be read:\n` +
        problems.map((problem) => `  ${problem.message}`).join("\n"),
    );
  }
  return entries;
}

/** The module doc's `sources:` block, read off the AUTHORED manifest — publish
 *  removes it from the text that ships. Fatal when unreadable, for the reason
 *  `readNativeFiles` gives; a source naming no notices is one such block. */
export function readSources(ownerJson: unknown, manifestDir: string): ModuleSource[] {
  const { sources, problems } = readModuleSources(ownerJson);
  if (problems.length > 0) {
    throw new Error(
      `Module '${path.basename(manifestDir)}' declares a sources: block that cannot be read:\n` +
        problems.map((problem) => `  ${problem.message} (at ${problem.path})`).join("\n") +
        `\nA staged file ships with the notices its source names, and its digest comes from ` +
        `its pin, so neither can be derived from a block that does not read.`,
    );
  }
  return sources;
}

export interface StagedFile {
  readonly source: ModuleSource;
  readonly entry: SourceEntry;
}

export function stagedEntriesOf(sources: readonly ModuleSource[]): Map<string, StagedFile> {
  const out = new Map<string, StagedFile>();
  for (const source of sources) {
    for (const entry of source.entries) out.set(entry.path, { source, entry });
  }
  return out;
}

/**
 * Refuse a payload whose named files cannot ship as the manifest describes them.
 *
 * For each stageable file (`stageableFiles`) that no build produces, and each
 * notice a source names:
 *
 * - staged by a source — read from its pin, the pin must exist; read from disk
 *   (publish), what is on disk must match it, so a stale or tampered file never
 *   ships under a pin that says otherwise;
 * - staged by none — the file must exist, and at publish a native or candidate
 *   file must be tracked by git: a binary nobody committed and nothing fetches
 *   is one the next checkout cannot reproduce.
 *
 * A source entry nothing names is refused too, as `telo check` refuses it, or a
 * `files:` pattern would ship it from a staged tree and not from a cold one.
 */
export async function assertNamedFiles(
  manifestDir: string,
  native: readonly NativeEntry[],
  claims: readonly ModuleFileClaim[],
  sources: readonly ModuleSource[],
  staged: ReadonlyMap<string, StagedFile>,
  fromPins: boolean,
): Promise<void> {
  const stageable = stageableFiles(
    native,
    claims.map((claim) => ({ claim })),
  );
  const notices: Array<[string, string]> = sources.flatMap((source) =>
    source.notices.map((notice): [string, string] => [notice, `notice of source '${source.name}'`]),
  );

  const problems: string[] = [];
  const unstaged: Array<{ path: string; label: string }> = [];
  const named: Array<[string, string]> = [...stageable.values()]
    .filter((file) => !file.built)
    .map((file) => [file.path, file.label]);
  for (const [file, label] of [...named, ...notices]) {
    const stagedFile = staged.get(file);
    if (!stagedFile) {
      if (!isFileOrLink(path.resolve(manifestDir, file))) {
        problems.push(`${label}: '${file}' is not a file, and no sources: entry stages it`);
      } else if (!fromPins && stageable.has(file)) {
        unstaged.push({ path: file, label });
      }
      continue;
    }
    const { source, entry } = stagedFile;
    const by = `${label}: '${file}' is staged by source '${source.name}'`;
    if (fromPins) {
      if (entry.kind === "file" && !entry.pin) {
        problems.push(`${by} but carries no pin — run \`telo release stage --pin\` (SOURCE_ENTRY_UNPINNED)`);
      }
      continue;
    }
    const verdict = await checkStagedEntry(manifestDir, source, entry);
    if (verdict.state === "unpinned") {
      problems.push(`${by} but carries no pin — run \`telo release stage --pin\` (SOURCE_ENTRY_UNPINNED)`);
    } else if (verdict.state === "missing") {
      problems.push(`${by}, but ${verdict.detail} — run \`telo release stage\` first`);
    } else if (verdict.state === "mismatch") {
      problems.push(`${by}, but its bytes do not match its pin: ${verdict.detail}`);
    }
  }
  for (const { source, entry } of unclaimedSourceEntries(sources, stageable)) {
    problems.push(
      `source '${source.name}' entry '${entry.key}': nothing in the manifest names '${entry.path}' ` +
        `(SOURCE_ENTRY_UNCLAIMED)`,
    );
  }
  for (const { path: file, label } of untrackedByGit(manifestDir, unstaged)) {
    problems.push(
      `${label}: '${file}' is not tracked by git, and no sources: entry stages it — commit ` +
        `it, or declare the archive it comes from under sources:`,
    );
  }
  if (problems.length === 0) return;
  throw new Error(
    `Module '${path.basename(manifestDir)}' names files that cannot ship:\n` +
      `${problems.map((line) => `  ${line}`).join("\n")}\n` +
      `A named file ships from its sources: pin or as a committed file; staging is ` +
      `\`telo release stage\`, which publish never runs itself.`,
  );
}

function isFileOrLink(abs: string): boolean {
  try {
    const stat = fs.lstatSync(abs);
    return stat.isFile() || stat.isSymbolicLink();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** The files git does not track, of those given, asked of the module's own
 *  work tree. Not being able to ask is a failure, never a pass. */
function untrackedByGit<T extends { path: string }>(manifestDir: string, files: readonly T[]): T[] {
  if (files.length === 0) return [];
  let listed: string;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--", ...files.map((file) => file.path)], {
      cwd: manifestDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    throw new Error(
      `Cannot tell whether ${files.map((file) => `'${file.path}'`).join(", ")} is committed: ` +
        `\`git ls-files\` failed in ${manifestDir}` +
        `${typeof stderr === "string" && stderr.trim() !== "" ? ` (${stderr.trim()})` : ""}. ` +
        `Publish ships a native file no sources: entry stages only when git tracks it — publish ` +
        `from the module's git work tree, or declare the file's source.`,
    );
  }
  const tracked = new Set(listed.split("\0").filter((entry) => entry !== ""));
  return files.filter((file) => !tracked.has(file.path));
}
