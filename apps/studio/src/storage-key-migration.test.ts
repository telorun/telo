import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_MIGRATION,
  SESSION_MIGRATION,
  migrateLegacyStorageKeys,
  migrateStorageKeys,
  type MigrationTable,
} from "./storage-key-migration";
import { LOCAL_KEYS, LOCAL_PREFIXES, SESSION_PREFIXES } from "./storage-keys";

/** A one-shot migration gets one chance, so a row that silently matches
 *  nothing — or targets a key no reader looks at — loses data with no way
 *  back. These tests pin both directions. */

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("the legacy key set is covered", () => {
  // Written out independently of the tables: this is the closed, historical
  // set of keys the pre-rename app wrote, so it never grows and a row deleted
  // or re-filed under the wrong store shows up here. Asserting the opposite
  // direction — that every CURRENT key has a row — would be wrong: a key added
  // after the rename has no legacy predecessor and must have no row.
  const LEGACY_LOCAL = [
    "telo-editor-v1",
    "telo-editor-v2",
    "telo-editor-settings-v1",
    "telo-editor-accepted-terms",
    "telo-editor-deployments-v1",
    "telo-editor-preview-notice-dismissed-v1",
    "telo-editor-history-v1:",
    "telo-editor-workspace:",
    "telo-editor:runs-v1",
    "telo-editor:color-mode",
    "telo-editor:agent-settings-v1",
    "telo-editor:agent-chat:",
    "telo-editor:agent-conv:",
  ];
  const LEGACY_SESSION = ["telo-editor:io-last-seq:", "telo-editor:sse-last-event-id:"];

  const legacyOf = (t: MigrationTable) => [
    ...t.renamedKeys.map(([from]) => from),
    ...t.renamedPrefixes.map(([from]) => from),
    ...t.droppedKeys,
  ];

  it("localStorage table names every legacy localStorage key", () => {
    expect(legacyOf(LOCAL_MIGRATION).sort()).toEqual([...LEGACY_LOCAL].sort());
  });

  it("sessionStorage table names every legacy sessionStorage key", () => {
    expect(legacyOf(SESSION_MIGRATION).sort()).toEqual([...LEGACY_SESSION].sort());
  });

  it("every current key is the target of at most one row", () => {
    for (const table of [LOCAL_MIGRATION, SESSION_MIGRATION]) {
      const targets = [
        ...table.renamedKeys.map(([, to]) => to),
        ...table.renamedPrefixes.map(([, to]) => to),
      ];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

describe("whole-key renames", () => {
  it.each(LOCAL_MIGRATION.renamedKeys)("%s -> %s", (legacy, current) => {
    const value = JSON.stringify({ marker: legacy });
    window.localStorage.setItem(legacy, value);

    migrateLegacyStorageKeys();

    expect(window.localStorage.getItem(current)).toBe(value);
    expect(window.localStorage.getItem(legacy)).toBeNull();
  });
});

describe("prefix renames carry the variable tail verbatim", () => {
  const tails = ["/workspace/app/telo.yaml", "run-42", "a:b:c", ""];

  it.each(LOCAL_MIGRATION.renamedPrefixes)("%s -> %s", (legacy, current) => {
    for (const [i, tail] of tails.entries()) {
      window.localStorage.setItem(`${legacy}${tail}`, `value-${i}`);
    }

    migrateLegacyStorageKeys();

    for (const [i, tail] of tails.entries()) {
      expect(window.localStorage.getItem(`${current}${tail}`)).toBe(`value-${i}`);
      expect(window.localStorage.getItem(`${legacy}${tail}`)).toBeNull();
    }
  });

  it.each(SESSION_MIGRATION.renamedPrefixes)("%s -> %s", (legacy, current) => {
    window.sessionStorage.setItem(`${legacy}session-7`, "128");

    migrateLegacyStorageKeys();

    expect(window.sessionStorage.getItem(`${current}session-7`)).toBe("128");
    expect(window.sessionStorage.getItem(`${legacy}session-7`)).toBeNull();
  });
});

describe("store separation", () => {
  // The defect this guards: run cursors are sessionStorage, everything else is
  // localStorage. A row applied to the wrong store matches nothing, and the
  // legacy key is then never migrated and never cleared.
  it("migrates session cursors from sessionStorage, not localStorage", () => {
    const [legacy, current] = SESSION_MIGRATION.renamedPrefixes[0];
    window.sessionStorage.setItem(`${legacy}s1`, "9");

    migrateLegacyStorageKeys();

    expect(window.sessionStorage.getItem(`${current}s1`)).toBe("9");
    expect(window.localStorage.getItem(`${current}s1`)).toBeNull();
  });

  it("leaves a session-table key sitting in localStorage alone", () => {
    const [legacy] = SESSION_MIGRATION.renamedPrefixes[0];
    window.localStorage.setItem(`${legacy}s1`, "9");

    migrateStorageKeys(window.localStorage, LOCAL_MIGRATION);

    expect(window.localStorage.getItem(`${legacy}s1`)).toBe("9");
  });
});

describe("edge cases", () => {
  it("keeps the value already at the target and still drops the legacy key", () => {
    window.localStorage.setItem("telo-editor-v2", JSON.stringify({ rootDir: "/old" }));
    window.localStorage.setItem(LOCAL_KEYS.uiState, JSON.stringify({ rootDir: "/new" }));

    migrateLegacyStorageKeys();

    expect(window.localStorage.getItem(LOCAL_KEYS.uiState)).toBe(
      JSON.stringify({ rootDir: "/new" }),
    );
    expect(window.localStorage.getItem("telo-editor-v2")).toBeNull();
  });

  it("drops a legacy key no reader understands", () => {
    window.localStorage.setItem("telo-editor-v1", "{}");

    migrateLegacyStorageKeys();

    expect(window.localStorage.getItem("telo-editor-v1")).toBeNull();
  });

  it("leaves unrelated keys untouched", () => {
    window.localStorage.setItem("someone-elses-key", "keep me");
    window.localStorage.setItem(LOCAL_KEYS.settings, "already current");

    migrateLegacyStorageKeys();

    expect(window.localStorage.getItem("someone-elses-key")).toBe("keep me");
    expect(window.localStorage.getItem(LOCAL_KEYS.settings)).toBe("already current");
  });

  it("is idempotent", () => {
    window.localStorage.setItem("telo-editor-v2", "state");
    window.localStorage.setItem(`telo-editor-workspace:/workspace/a.yaml`, "text");

    migrateLegacyStorageKeys();
    const after = { ...window.localStorage };
    migrateLegacyStorageKeys();

    expect({ ...window.localStorage }).toEqual(after);
  });

  it("reports a key it cannot write and leaves it for a later run", () => {
    window.localStorage.setItem("telo-editor-v2", "state");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    try {
      migrateLegacyStorageKeys();
    } finally {
      setItem.mockRestore();
    }

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("telo-editor-v2"),
      expect.any(DOMException),
    );
    expect(window.localStorage.getItem("telo-editor-v2")).toBe("state");
    warn.mockRestore();
  });
});
