/**
 * A baseline replaces a long run's entries in one rename, so a crash at any
 * point leaves the old file or the new one — never both and never neither.
 */
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../src/journal.js";

/** The process "dies" between staging the new file and renaming it into place:
 *  what is on disk is exactly what a crash there leaves. */
const crash = vi.hoisted(() => ({ beforeRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (crash.beforeRename) throw new Error("process died before the rename");
      return actual.rename(from, to);
    },
  };
});

let dir: string;
let journal: any;

beforeEach(async () => {
  crash.beforeRename = false;
  dir = await mkdtemp(join(tmpdir(), "telo-journal-baseline-"));
  journal = await create({ directory: dir, metadata: { name: "j" } } as never, {} as never);
  await journal.init();
  await journal.admitRun("run-1", { workflow: "w" });
  for (const path of ["inputs", "steps/a", "steps/b", "steps/c"]) {
    await journal.append("run-1", { path, kind: "decision", v: 2, value: `"${path}"` });
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASELINE = { path: "steps/b", kind: "baseline", v: 2, value: '{"position":[],"steps":{}}' };
const staging = () => join(dir, "run-1.ndjson.compacting");

describe("the file journal's baseline", () => {
  it("replaces exactly the listed entries and keeps the run's record and every other entry", async () => {
    await journal.replaceWithBaseline("run-1", BASELINE, ["steps/a", "steps/b"]);
    expect((await journal.readEntries("run-1")).map((e: { path: string }) => e.path)).toEqual([
      "inputs",
      "steps/c",
      "steps/b",
    ]);
    expect((await journal.readEntries("run-1"))[2]).toEqual(BASELINE);
    expect(await journal.readRun("run-1")).toMatchObject({ run: "run-1", status: "running", workflow: "w" });
    await expect(access(staging())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the old entries after a crash before the rename, and never reads what that crash left behind", async () => {
    const before = await journal.readEntries("run-1");
    crash.beforeRename = true;
    await expect(journal.replaceWithBaseline("run-1", BASELINE, ["steps/a", "steps/b"])).rejects.toThrow(
      "process died before the rename",
    );
    crash.beforeRename = false;

    expect(await journal.readEntries("run-1")).toEqual(before);
    await access(staging());
    expect(await journal.dueRuns(Date.now(), 10)).toEqual(["run-1"]);

    // The next compaction overwrites the leftover rather than reading it.
    await journal.replaceWithBaseline("run-1", BASELINE, ["steps/a", "steps/b"]);
    expect((await journal.readEntries("run-1")).map((e: { path: string }) => e.path)).toEqual([
      "inputs",
      "steps/c",
      "steps/b",
    ]);
    await expect(access(staging())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purges a leftover staging file with the run", async () => {
    await writeFile(staging(), "torn");
    await journal.completeRun("run-1", { status: "completed" });
    expect(await journal.deleteFinishedRun("run-1", Date.now())).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});
