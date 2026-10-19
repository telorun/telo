import { classifySensitiveEnvFiles, WORKSPACE_FILENAME } from "@telorun/analyzer";
import { SYNC_EXCLUDED_DIRS } from "../agent/sync";
import { VIRTUAL_WORKSPACE_ROOT } from "../loader/remote";
import { LOCAL_PREFIXES } from "../storage-keys";
import type { ImportFile } from "./working-copy";

const FILE_KEY_PREFIX = `${LOCAL_PREFIXES.workspace}${VIRTUAL_WORKSPACE_ROOT}/`;

function fileKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(FILE_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** The files a copy reads — everything outside the excluded directories — and
 *  which of them the nearest `telo-workspace.yaml` marks sensitive. Rejects
 *  with the marker's message when a marker's `env:` is refused, since which
 *  files hold secrets is then unknown. */
async function classifyBrowserWorkspace(
  storage: Storage,
): Promise<{ texts: Map<string, string>; sensitive: ReadonlySet<string> }> {
  const texts = new Map<string, string>();
  for (const key of fileKeys(storage)) {
    const path = key.slice(FILE_KEY_PREFIX.length);
    if (path.split("/").some((segment) => SYNC_EXCLUDED_DIRS.has(segment))) continue;
    const text = storage.getItem(key);
    if (text !== null) texts.set(path, text);
  }
  const classified = await classifySensitiveEnvFiles([...texts.keys()], async (path) => {
    const text = texts.get(path);
    return text === undefined ? { kind: "missing" } : { kind: "text", text };
  });
  if ("failed" in classified) throw new Error(classified.failed);
  return { texts, sensitive: classified.sensitive };
}

/** The browser-stored workspace's files, by path relative to its root. What a
 *  repository should not hold — caches, build output, the agent's own state,
 *  and every sensitive env file — is left out: a working copy commits
 *  everything outside `.git`. */
export async function readBrowserWorkspaceFiles(
  storage: Storage = window.localStorage,
): Promise<ImportFile[]> {
  const { texts, sensitive } = await classifyBrowserWorkspace(storage);
  return [...texts]
    .filter(([path]) => !sensitive.has(path))
    .map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** What removing the browser workspace keeps: the sensitive env files a copy
 *  leaves out — their secrets exist nowhere else — and every
 *  `telo-workspace.yaml` at or above one of them, which marks it sensitive. */
export async function browserWorkspaceKeptFiles(
  storage: Storage = window.localStorage,
): Promise<string[]> {
  const { texts, sensitive } = await classifyBrowserWorkspace(storage);
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  const markers = [...texts.keys()].filter(
    (path) =>
      path.slice(path.lastIndexOf("/") + 1) === WORKSPACE_FILENAME &&
      [...sensitive].some((file) => file.startsWith(dirOf(path))),
  );
  return [...sensitive, ...markers].sort((a, b) => a.localeCompare(b));
}

/** Identifies a set of files by their paths and bytes. */
export async function filesDigest(files: ImportFile[]): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(new TextEncoder().encode(`${file.path}\0${file.bytes.length}\0`), file.bytes);
  }
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Removes the browser-stored workspace's files from this device, except what
 *  `browserWorkspaceKeptFiles` keeps, judged afresh. Rejects with the marker's
 *  message, having deleted nothing, when a marker's `env:` is refused. */
export async function removeBrowserWorkspaceFiles(
  storage: Storage = window.localStorage,
): Promise<void> {
  const kept = new Set(await browserWorkspaceKeptFiles(storage));
  for (const key of fileKeys(storage)) {
    if (!kept.has(key.slice(FILE_KEY_PREFIX.length))) storage.removeItem(key);
  }
}
