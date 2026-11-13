/**
 * The one digest every layer is taken with: a file set, never archive bytes.
 *
 * SHA-256 over the sorted lines of every file — `<path>\0<sha256(content)>`, an
 * executable file `…\0x`, a symbolic link `<path>\0l\0<target>` — returned as
 * `sha256-<base64url>`. Hashing contents rather than a tarball makes the digest
 * independent of compression and framing, so a file set packed locally and one
 * unpacked from a registry give one number. It is the module artifact rule,
 * restated here with nothing excluded.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_PATH } from "../ledger.js";

export type FileSetEntry =
  | { readonly path: string; readonly content: Uint8Array; readonly executable?: boolean }
  | { readonly path: string; readonly link: string };

/**
 * The planner's own bookkeeping, workspace-relative: the ledger and the pending
 * fragments. No layer holds it — `apply` rewrites it after the layers are read,
 * so a layer reaching it (a build context at the root, a `**` payload) would
 * move with every release it records.
 */
export const BOOKKEEPING_DIR = path.posix.dirname(LEDGER_PATH);

/** Whether a workspace-relative path lies in {@link BOOKKEEPING_DIR}. */
export function isBookkeeping(workspaceRelative: string): boolean {
  return workspaceRelative === BOOKKEEPING_DIR || workspaceRelative.startsWith(`${BOOKKEEPING_DIR}/`);
}

/** The entries of a file set named relative to the workspace directory `dir`,
 *  less the bookkeeping. */
export function withoutBookkeeping<T extends { readonly path: string }>(entries: readonly T[], dir: string): T[] {
  return entries.filter((entry) => !isBookkeeping(dir === "" ? entry.path : `${dir}/${entry.path}`));
}

function sha256(bytes: Uint8Array | string): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function digestFileSet(entries: readonly FileSetEntry[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`'${entry.path}' is listed twice in one file set.`);
    seen.add(entry.path);
    if ("link" in entry) {
      lines.push(`${entry.path}\0l\0${entry.link}`);
      continue;
    }
    const digest = sha256(entry.content).toString("base64url");
    lines.push(entry.executable ? `${entry.path}\0${digest}\0x` : `${entry.path}\0${digest}`);
  }
  lines.sort();
  return `sha256-${sha256(lines.join("\n")).toString("base64url")}`;
}

/** One file of a directory as the kind it is — a link never followed, a file
 *  with any execute bit executable — named `as`. */
export function readFileSetEntry(dir: string, relative: string, as: string = relative): FileSetEntry {
  const abs = path.join(dir, relative);
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) return { path: as, link: fs.readlinkSync(abs).replace(/\\/g, "/") };
  if (!stat.isFile()) throw new Error(`'${relative}' is neither a regular file nor a symbolic link.`);
  const content = fs.readFileSync(abs);
  return (stat.mode & 0o111) !== 0 ? { path: as, content, executable: true } : { path: as, content };
}

/** Every file beneath `dir`, `/`-separated and relative to it, skipping the
 *  directories no build reads (`.git`, `node_modules`). */
export function listFiles(dir: string, prune: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (prune.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return found.sort();
}
