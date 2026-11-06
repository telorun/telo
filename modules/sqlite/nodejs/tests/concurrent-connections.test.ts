import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { create } from "../src/connection-controller.js";

const addon = createRequire(import.meta.url).resolve("better-sqlite3/build/Release/better_sqlite3.node");

const ctx = {
  resolveNativeFile: async () => pathToFileURL(addon).href,
  log: { enabled: () => false, debug() {} },
  zonesFor: () => [],
} as never;

const open = (file: string, name: string) => create({ metadata: { name, module: "t" }, file }, ctx);

describe("two connections to one file in one process", () => {
  it("lets the second wait for the first's write lock instead of blocking the thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
    const first = await open(join(dir, "db.sqlite"), "first");
    const second = await open(join(dir, "db.sqlite"), "second");
    try {
      await first.execute("CREATE TABLE t (i INTEGER)");
      await first.execute("BEGIN IMMEDIATE");
      // Would block the thread until its timeout if the wait were the engine's.
      const waiting = second.execute("BEGIN IMMEDIATE");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await first.execute("INSERT INTO t VALUES (1)");
      await first.execute("COMMIT");
      await waiting;
      await second.execute("INSERT INTO t VALUES (2)");
      await second.execute("COMMIT");

      const rows = await first.execute<{ i: number }>("SELECT i FROM t ORDER BY i");
      expect(rows.rows.map((row) => row.i)).toEqual([1, 2]);
    } finally {
      await first.kysely.destroy();
      await second.kysely.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
