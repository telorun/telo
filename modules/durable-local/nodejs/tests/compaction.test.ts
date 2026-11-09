/**
 * Compaction's due check against the shapes a resume can leave behind.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRunHandle } from "../src/run-handle.js";
import { create as createJournal } from "../../../durable-journal-file/nodejs/src/journal.js";
import type { DurableJournal } from "../src/journal.js";
import { ResumerController } from "../src/resumer.js";

let dir: string;
let journal: DurableJournal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telo-compaction-"));
  const controller = await createJournal({ directory: dir, metadata: { name: "j" } } as never, {} as never);
  await controller.init();
  journal = controller as unknown as DurableJournal;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const log = { info() {}, warn() {}, error() {}, enabled: () => false } as never;
const capture = () => ({ position: [{ step: "steps/t" }], steps: {} });

describe("compaction after a resume takes another branch", () => {
  it("is due once the completed step's subtree is passed, though a recorded entry was never reached", async () => {
    await journal.admitRun("r");
    // First execution: `b` failed, `c` ran in the catch, then the process died.
    const first = await LocalRunHandle.open("r", journal, log);
    await first.step("steps/t/try/a", undefined, {}, async () => 1);
    await first.step("steps/t/catch/c", undefined, {}, async () => 2);

    // Resume: `b` succeeds this time, so `c` is never passed again.
    const resumed = await LocalRunHandle.open("r", journal, log, { compactAfter: 2, body: "steps" });
    await resumed.step("steps/t/try/a", undefined, {}, async () => 1);
    await resumed.step("steps/t/try/b", undefined, {}, async () => 3);

    expect(resumed.baseline(capture, "steps/t/try/b")).toBeUndefined();
    const written = resumed.baseline(capture, "steps/t");
    expect(written).toBeDefined();
    await written;
    expect((await journal.readEntries("r")).map((e) => e.kind)).toEqual(["baseline"]);
  });
});

describe("a journal with only the original operations", () => {
  it("never compacts, and the retention sweep neither throws nor warns", async () => {
    const old = {
      admitRun: journal.admitRun.bind(journal),
      readRun: journal.readRun.bind(journal),
      readEntries: journal.readEntries.bind(journal),
      append: journal.append.bind(journal),
      completeRun: journal.completeRun.bind(journal),
      dueRuns: async () => [],
      claimRun: async () => true,
    } as unknown as DurableJournal;
    await old.admitRun("r");
    const handle = await LocalRunHandle.open("r", old, log, { compactAfter: 1, body: "steps" });
    await handle.step("steps/a", undefined, {}, async () => 1);
    expect(handle.baseline(capture, "steps/a")).toBeUndefined();

    const warn = vi.fn();
    const ctx = {
      resolveRef: () => ({ name: "wf", retainFinishedMs: 0, execute: async () => {} }),
      log: { info() {}, warn, error: warn, enabled: () => false },
      errorValueOf: (e: unknown) => e,
    };
    const resumer = new ResumerController(
      { metadata: { name: "resumer" }, workflow: {}, journal: old } as never,
      ctx as never,
    );
    await (resumer as unknown as { purgeFinished(w: unknown, j: unknown): Promise<void> }).purgeFinished(
      { name: "wf", retainFinishedMs: 0 },
      old,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
