import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create as createJournal } from "../../../durable-journal-file/nodejs/src/journal.js";
import type { DurableJournal } from "../src/journal.js";
import { ResumerController } from "../src/resumer.js";
import { LocalRunHandle } from "../src/run-handle.js";

let dir: string;
let journal: DurableJournal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telo-resumer-"));
  const controller = await createJournal({ directory: dir, metadata: { name: "j" } } as never, {} as never);
  await controller.init();
  journal = controller as unknown as DurableJournal;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("DurableLocal.Resumer", () => {
  it("skips a run it cannot read, reporting its code once, and keeps resuming the others", async () => {
    await journal.admitRun("run-future");
    await journal.append("run-future", { path: "steps/a", kind: "step", v: 99, value: "{}" });
    await journal.admitRun("run-readable");

    const executed: string[] = [];
    const errors: unknown[] = [];
    const workflow = {
      journal: () => journal,
      async execute(run: string) {
        executed.push(run);
        await LocalRunHandle.open(run, journal, {} as never);
      },
    };
    const ctx = {
      resolveRef: () => workflow,
      log: { info() {}, warn() {}, error: (message: string, attributes: unknown) => errors.push({ message, attributes }) },
    };
    const resumer = new ResumerController({ metadata: { name: "resumer" }, workflow: {} } as never, ctx as never);
    const sweep = () => (resumer as unknown as { sweep(): Promise<void> }).sweep();

    await sweep();
    // Past the claim TTL, so both runs are offered again.
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    await journal.admitRun("run-later");
    await sweep();

    // A directory lists in no promised order, so the attempts are compared as a set.
    expect(executed.sort()).toEqual(["run-future", "run-later", "run-readable", "run-readable"]);
    expect(errors).toEqual([
      {
        message: "Cannot read an interrupted run; this resumer skips it from now on",
        attributes: expect.objectContaining({ "durable.run": "run-future", "error.code": "ERR_DURABLE_ENTRY_UNDECODABLE" }),
      },
    ]);
  });
});
