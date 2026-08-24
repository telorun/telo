/** Rewrites the browser-storage keys written under the app's former name
 *  (`telo-editor`) to the current scheme, declared in `storage-keys.ts`.
 *
 *  Runs once at startup, before any store reads, so every reader sees only the
 *  current spelling and no individual store carries a legacy fallback.
 *
 *  Both stores are migrated, and which table applies to which is load-bearing:
 *  run resume cursors live in `sessionStorage` and everything else in
 *  `localStorage`, so a row filed under the wrong store is a row that never
 *  matches anything.
 *
 *  A key that fails to move is reported and left where it is — the app then
 *  reads it as absent, which is recoverable, where a throw here would take the
 *  whole app down before first paint. That does mean a run interrupted by an
 *  exhausted quota can leave storage straddling both schemes until a later
 *  start retries it; every reader treats its own missing key as "no persisted
 *  state", so the straddle degrades rather than corrupts.
 */

import { LOCAL_KEYS, LOCAL_PREFIXES, SESSION_PREFIXES } from "./storage-keys";

/** A whole-key rename: the key is a fixed string with nothing appended. */
export type KeyRename = readonly [legacy: string, current: string];

/** A prefix rename: everything past the prefix is a variable segment
 *  (workspace path, run id, conversation id) and is carried over verbatim. */
export type PrefixRename = readonly [legacyPrefix: string, currentPrefix: string];

export interface MigrationTable {
  readonly renamedKeys: readonly KeyRename[];
  readonly renamedPrefixes: readonly PrefixRename[];
  /** Keys holding a shape no current reader understands. */
  readonly droppedKeys: readonly string[];
}

export const LOCAL_MIGRATION: MigrationTable = {
  renamedKeys: [
    ["telo-editor-v2", LOCAL_KEYS.uiState],
    ["telo-editor-settings-v1", LOCAL_KEYS.settings],
    ["telo-editor-accepted-terms", LOCAL_KEYS.acceptedTerms],
    ["telo-editor-deployments-v1", LOCAL_KEYS.deployments],
    ["telo-editor:runs-v1", LOCAL_KEYS.runIndex],
    ["telo-editor:color-mode", LOCAL_KEYS.colorMode],
    ["telo-editor-preview-notice-dismissed-v1", LOCAL_KEYS.previewNoticeDismissed],
    ["telo-editor:agent-settings-v1", LOCAL_KEYS.agentSettings],
  ],
  renamedPrefixes: [
    ["telo-editor-workspace:", LOCAL_PREFIXES.workspace],
    ["telo-editor-history-v1:", LOCAL_PREFIXES.history],
    ["telo-editor:agent-chat:", LOCAL_PREFIXES.agentChat],
    ["telo-editor:agent-conv:", LOCAL_PREFIXES.agentConv],
  ],
  // `telo-editor-v1` was already deleted on load before the rename.
  droppedKeys: ["telo-editor-v1"],
};

export const SESSION_MIGRATION: MigrationTable = {
  renamedKeys: [],
  renamedPrefixes: [
    ["telo-editor:io-last-seq:", SESSION_PREFIXES.runIoSeq],
    ["telo-editor:sse-last-event-id:", SESSION_PREFIXES.runSseEventId],
  ],
  droppedKeys: [],
};

function renameTargetFor(key: string, table: MigrationTable): string | null {
  for (const [from, to] of table.renamedKeys) if (key === from) return to;
  for (const [from, to] of table.renamedPrefixes) {
    if (key.startsWith(from)) return to + key.slice(from.length);
  }
  return null;
}

/** Applies one table to one store. Exported for the tests, which drive it over
 *  a store they control rather than the ambient one. */
export function migrateStorageKeys(store: Storage, table: MigrationTable): void {
  // Snapshot the key list: the loop adds and removes entries, and `key(i)`
  // walks a live index.
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k) keys.push(k);
  }

  for (const key of keys) {
    try {
      if (table.droppedKeys.includes(key)) {
        store.removeItem(key);
        continue;
      }
      const target = renameTargetFor(key, table);
      if (target === null) continue;

      // A value already at the target was written by this build and is newer
      // than anything under the old name — drop the legacy entry rather than
      // overwrite it.
      if (store.getItem(target) === null) {
        const value = store.getItem(key);
        if (value !== null) store.setItem(target, value);
      }
      store.removeItem(key);
    } catch (err) {
      // Quota exhaustion on the write, most likely. The legacy key is left
      // intact so a later run can retry it.
      console.warn(`[studio] could not migrate legacy storage key ${key}`, err);
    }
  }
}

export function migrateLegacyStorageKeys(): void {
  if (typeof window === "undefined") return;

  for (const [label, get, table] of [
    ["localStorage", () => window.localStorage, LOCAL_MIGRATION],
    ["sessionStorage", () => window.sessionStorage, SESSION_MIGRATION],
  ] as const) {
    let store: Storage;
    try {
      store = get();
    } catch (err) {
      // Storage denied outright (private mode, blocked cookies). Every store in
      // the app already treats that as "no persisted state"; say so once.
      console.warn(`[studio] ${label} unavailable — legacy keys not migrated`, err);
      continue;
    }
    migrateStorageKeys(store, table);
  }
}
