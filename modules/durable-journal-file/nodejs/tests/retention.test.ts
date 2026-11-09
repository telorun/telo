/**
 * Retention: listing finished runs of one workflow and deleting one whole.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../src/journal.js";

let dir: string;
let journal: any;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telo-journal-"));
  journal = await create({ directory: dir, metadata: { name: "j" } } as never, {} as never);
  await journal.init();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function finish(run: string, workflow: string, status = "completed"): Promise<void> {
  await journal.admitRun(run, { workflow });
  await journal.append(run, { path: "steps/a", kind: "step", value: "1" });
  await journal.completeRun(run, { status });
}

describe("file journal retention", () => {
  it("stamps the finish time and keeps the workflow through settlement", async () => {
    await finish("a", "wf");
    const record = await journal.readRun("a");
    expect(record.workflow).toBe("wf");
    expect(record.finishedAt).toBeGreaterThan(0);
  });

  it("lists only terminal runs of that workflow finished before the cutoff", async () => {
    await finish("done", "wf");
    await finish("failed", "wf", "failed");
    await finish("other", "other");
    await journal.admitRun("live", { workflow: "wf" });
    await journal.admitRun("parked", { workflow: "wf" });
    await journal.parkRun("parked", { path: "steps/b", resource: "r", at: Date.now() + 1e9 });
    await journal.admitRun("legacy");
    await journal.completeRun("legacy", { status: "completed" });

    expect((await journal.finishedRuns("wf", Date.now() + 1, 10)).sort()).toEqual(["done", "failed"]);
    expect(await journal.finishedRuns("wf", 0, 10)).toEqual([]);
    expect(await journal.finishedRuns("wf", Date.now() + 1, 1)).toHaveLength(1);
  });

  it("deletes the record and every entry, and only a finished run past the cutoff", async () => {
    await finish("done", "wf");
    await journal.admitRun("live", { workflow: "wf" });

    expect(await journal.deleteFinishedRun("done", 0)).toBe(false);
    expect(await journal.deleteFinishedRun("live", Date.now() + 1)).toBe(false);
    expect(await journal.deleteFinishedRun("done", Date.now() + 1)).toBe(true);

    expect(await journal.readRun("done")).toBeUndefined();
    expect(await journal.readEntries("done")).toEqual([]);
    expect(await readdir(dir)).toEqual(["live.ndjson"]);
    expect(await journal.deleteFinishedRun("done", Date.now() + 1)).toBe(false);
  });
});

describe("file journal concurrent purge", () => {
  it("answers false for a run another purge already removed", async () => {
    await finish("done", "wf");
    const cutoff = Date.now() + 1;
    const results = await Promise.all([
      journal.deleteFinishedRun("done", cutoff),
      journal.deleteFinishedRun("done", cutoff),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });
});
