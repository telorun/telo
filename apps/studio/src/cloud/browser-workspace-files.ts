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

/** The browser-stored workspace's files, by path relative to its root. What a
 *  repository should not hold — caches, build output, the agent's own state —
 *  is left out: a working copy commits everything outside `.git`. */
export function readBrowserWorkspaceFiles(storage: Storage = window.localStorage): ImportFile[] {
  const files: ImportFile[] = [];
  for (const key of fileKeys(storage)) {
    const path = key.slice(FILE_KEY_PREFIX.length);
    if (path.split("/").some((segment) => SYNC_EXCLUDED_DIRS.has(segment))) continue;
    const text = storage.getItem(key);
    if (text === null) continue;
    files.push({ path, bytes: new TextEncoder().encode(text) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
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

/** Removes every file of the browser-stored workspace from this device. */
export function removeBrowserWorkspaceFiles(storage: Storage = window.localStorage): void {
  for (const key of fileKeys(storage)) storage.removeItem(key);
}
