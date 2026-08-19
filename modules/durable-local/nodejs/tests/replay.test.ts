/**
 * The replay path itself — the one a RESUME takes.
 *
 * The manifest test beside this proves the idempotent-start half: submitting the
 * same run id twice attaches to the settled run instead of doing the work again.
 * That path never reaches the step engine, because a completed run answers from
 * its own record. What is exercised here is the other half and the harder one: a
 * run that was admitted, made progress, and never settled — the state a process
 * that died leaves behind — re-executed against the journal it left.
 *
 * Driving the controller directly rather than through a manifest is deliberate:
 * the interrupted state is produced by a process disappearing, and the honest
 * in-process equivalent is to stop calling `execute` half way rather than to
 * invent a manifest-level crash that would be a different thing wearing the same
 * name.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Stream, UNCANCELLABLE_CONTEXT, deriveContext, type ZoneEntry } from "@telorun/sdk";
import { LocalRunHandle } from "../src/run-handle.js";
import { create as createJournal } from "../../../durable-journal-file/nodejs/src/journal.js";
import type { DurableJournal } from "../src/journal.js";

let dir: string;
let journal: DurableJournal;

/** The slice of `ResourceContext` a journal controller actually touches. */
const journalCtx = {} as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telo-durable-"));
  const controller = await createJournal({ directory: dir, metadata: { name: "j" } } as never, journalCtx);
  await controller.init();
  journal = controller as unknown as DurableJournal;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TARGET = { kind: "Test.Effect", name: "charge" };

describe("LocalRunHandle — replaying an interrupted run", () => {
  it("returns a recorded result instead of executing, and executes what has none", async () => {
    await journal.admitRun("run-1");

    // First execution: two steps complete, then the process "dies" — the third
    // never runs, so nothing records it.
    const first = await LocalRunHandle.open("run-1", journal);
    let calls = 0;
    const effect = async () => ({ call: ++calls });
    expect(await first.step("steps/a", TARGET, {}, effect)).toEqual({ call: 1 });
    expect(await first.step("steps/b", TARGET, {}, effect)).toEqual({ call: 2 });

    // Second execution against the same journal — which is what a resume IS.
    const second = await LocalRunHandle.open("run-1", journal);
    expect(await second.step("steps/a", TARGET, {}, effect)).toEqual({ call: 1 });
    expect(await second.step("steps/b", TARGET, {}, effect)).toEqual({ call: 2 });
    // The counter is the assertion: the two recorded steps did NOT re-execute.
    expect(calls).toBe(2);

    // The step that never completed has no entry, so it runs now. Journal on
    // COMPLETION is what makes this right — recording on dispatch would have
    // marked it done and skipped work that never happened.
    expect(await second.step("steps/c", TARGET, {}, effect)).toEqual({ call: 3 });
    expect(calls).toBe(3);
    expect(second.observations.replayedSteps).toBe(2);
  });

  it("returns a recorded DECISION rather than recomputing it", async () => {
    await journal.admitRun("run-2");

    // A predicate over something that MOVES — the whole reason decisions are
    // journaled rather than re-derived. Re-evaluating it in a fresh process
    // would send the replay down a branch the run never took, and the journal
    // would then answer for steps under keys it reached for a different reason.
    let live = true;
    const first = await LocalRunHandle.open("run-2", journal);
    expect(await first.decide("steps/gate/if", "predicate", () => live)).toBe(true);

    live = false;
    const second = await LocalRunHandle.open("run-2", journal);
    expect(await second.decide("steps/gate/if", "predicate", () => live)).toBe(true);
  });

  it("refuses to answer for a step whose target changed under the run", async () => {
    await journal.admitRun("run-3");
    const first = await LocalRunHandle.open("run-3", journal);
    await first.step("steps/a", TARGET, {}, async () => ({ ok: true }));

    // The body moved while a run was live. Handing this step the recorded result
    // would give it a value produced by a different resource — divergence with
    // no error, which is precisely what durability exists to prevent.
    const second = await LocalRunHandle.open("run-3", journal);
    await expect(
      second.step("steps/a", { kind: "Test.Effect", name: "refund" }, {}, async () => ({})),
    ).rejects.toMatchObject({ code: "ERR_JOURNAL_ENTRY_MISMATCH" });
  });

  it("refuses a value that cannot be recorded, naming the step that produced it", async () => {
    await journal.admitRun("run-4");
    const handle = await LocalRunHandle.open("run-4", journal);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      handle.step("steps/leak", TARGET, {}, async () => cyclic),
    ).rejects.toMatchObject({ code: "ERR_DURABLE_UNJOURNALABLE_VALUE" });
  });

  it("refuses a LIVE value, which serializing cannot detect", async () => {
    // The case the spec names first, and the one a `JSON.stringify` gate cannot
    // see: a stream has no enumerable state, so stringifying it SUCCEEDS and
    // yields `{}`. Recorded, that would replay as an empty object — silent
    // corruption rather than the loud failure the contract requires.
    expect(JSON.stringify(new Stream((async function* () {})()))).toBe("{}");

    await journal.admitRun("run-live");
    const handle = await LocalRunHandle.open("run-live", journal);
    await expect(
      handle.step("steps/tail", TARGET, {}, async () => new Stream((async function* () {})())),
    ).rejects.toMatchObject({ code: "ERR_DURABLE_UNJOURNALABLE_VALUE" });
  });

  it("finds a live value nested inside an ordinary result", async () => {
    await journal.admitRun("run-nested");
    const handle = await LocalRunHandle.open("run-nested", journal);
    await expect(
      handle.step("steps/wrap", TARGET, {}, async () => ({
        ok: true,
        body: { chunks: [new Stream((async function* () {})())] },
      })),
    ).rejects.toMatchObject({ code: "ERR_DURABLE_UNJOURNALABLE_VALUE" });
  });

  it("records the module disambiguator and compares on it", async () => {
    await journal.admitRun("run-mod");
    const first = await LocalRunHandle.open("run-mod", journal);
    await first.step("steps/a", { ...TARGET, module: "Alpha" }, {}, async () => ({ ok: 1 }));

    // Same kind and name, DIFFERENT declaring module — two libraries may each
    // declare a `charge`, and answering for one with the other's result is the
    // divergence the mismatch check exists to catch.
    const second = await LocalRunHandle.open("run-mod", journal);
    await expect(
      second.step("steps/a", { ...TARGET, module: "Beta" }, {}, async () => ({ ok: 2 })),
    ).rejects.toMatchObject({ code: "ERR_JOURNAL_ENTRY_MISMATCH" });
  });

  it("still replays an entry recorded before the module was captured", async () => {
    // Gradual: an older entry carries no `module`, and inventing a mismatch from
    // a missing field would strand exactly the runs this protects.
    await journal.admitRun("run-legacy");
    await journal.append("run-legacy", {
      path: "steps/a",
      kind: "step",
      target: { kind: TARGET.kind, name: TARGET.name },
      value: { ok: 1 },
    });
    const handle = await LocalRunHandle.open("run-legacy", journal);
    expect(
      await handle.step("steps/a", { ...TARGET, module: "Alpha" }, {}, async () => ({ ok: 2 })),
    ).toEqual({ ok: 1 });
  });

  it("keeps the FIRST writer's value when two executions race one step", async () => {
    await journal.admitRun("run-5");
    const a = await LocalRunHandle.open("run-5", journal);
    const b = await LocalRunHandle.open("run-5", journal);

    // Neither handle has seen an entry, so both execute — which is the
    // at-least-once window a claim exists to narrow, not something the journal
    // can prevent. What it CAN guarantee is that both continue with the same
    // value, rather than each carrying its own into the rest of the run.
    const first = await a.step("steps/a", TARGET, {}, async () => ({ from: "a" }));
    const second = await b.step("steps/a", TARGET, {}, async () => ({ from: "b" }));
    expect(second).toEqual(first);
  });

  it("answers `writesInside` from the journal, not from the run", async () => {
    await journal.admitRun("run-6");
    const handle = await LocalRunHandle.open("run-6", journal);
    // A directory of files shares nothing with a database transaction, so this
    // store says no and its atomic regions collapse — which is correct, and is
    // what the conditional collapse rule reads.
    expect(handle.writesInside({ kind: "Sql.Transaction" } as unknown as ZoneEntry)).toBe(false);
  });

  it("refuses to park, rather than silently continuing", async () => {
    await journal.admitRun("run-7");
    const handle = await LocalRunHandle.open("run-7", journal);
    // Suspension is v1.1. A park that returned would convert a wait into a
    // completed step and duplicate every effect after it.
    await expect(handle.park()).rejects.toMatchObject({
      code: "ERR_DURABLE_PARK_UNSUPPORTED",
    });
  });
});

describe("an interrupted run stays resumable", () => {
  it("leaves a run admitted-but-unsettled when its process disappears", async () => {
    // The state a kill leaves behind, and the one the resumer looks for. It is
    // reached by NOT settling rather than by settling to a third status: a run
    // whose process vanished never reported anything, so there is nothing to
    // record about it that would not be a guess.
    await journal.admitRun("run-killed");
    const handle = await LocalRunHandle.open("run-killed", journal);
    await handle.step("steps/a", TARGET, {}, async () => ({ ok: true }));
    // …process dies here; nothing calls completeRun.

    expect(await journal.interruptedRuns(10)).toContain("run-killed");
    const resumed = await LocalRunHandle.open("run-killed", journal);
    // What finished is replayed; what did not, runs.
    let ran = false;
    expect(await resumed.step("steps/a", TARGET, {}, async () => ({ ok: false }))).toEqual({
      ok: true,
    });
    await resumed.step("steps/b", TARGET, {}, async () => {
      ran = true;
      return { ok: true };
    });
    expect(ran).toBe(true);
  });

  it("does not offer a settled run to the resumer", async () => {
    await journal.admitRun("run-done");
    await journal.completeRun("run-done", { status: "completed", result: {} });
    expect(await journal.interruptedRuns(10)).not.toContain("run-done");
  });
});

describe("an in-flight run is not started twice", () => {
  it("refuses a second admission and reports the run as still running", async () => {
    // `admitRun` is an exclusive create, so the second caller learns the run
    // exists rather than racing it. This is the half that makes a caller-chosen
    // run id an idempotent START — without it two callers submitting the same
    // operation would both execute, and both would write to one journal.
    expect((await journal.admitRun("run-race")).admitted).toBe(true);
    const second = await journal.admitRun("run-race");
    expect(second.admitted).toBe(false);
    expect(second.existing?.status).toBe("running");
  });

  it("hands the claim to one caller only", async () => {
    // The claim is what decides whether a caller attaching to a RUNNING run may
    // continue it: taking it means the previous holder is gone, failing it means
    // someone is actively working the run and continuing would duplicate every
    // unrecorded effect in it.
    await journal.admitRun("run-claim");
    expect(await journal.claimRun("run-claim", "holder-a", 60_000)).toBe(true);
    expect(await journal.claimRun("run-claim", "holder-b", 60_000)).toBe(false);
    // The holder that owns it renews rather than colliding with itself.
    expect(await journal.claimRun("run-claim", "holder-a", 60_000)).toBe(true);
  });

  it("stops offering a claimed run to a poller", async () => {
    await journal.admitRun("run-swept");
    expect(await journal.interruptedRuns(10)).toContain("run-swept");
    await journal.claimRun("run-swept", "holder-a", 60_000);
    expect(await journal.interruptedRuns(10)).not.toContain("run-swept");
  });
});

describe("the durable handle rides the invocation context", () => {
  it("is carried by deriveContext like every other member", async () => {
    await journal.admitRun("run-8");
    const handle = await LocalRunHandle.open("run-8", journal);
    const durable = deriveContext(UNCANCELLABLE_CONTEXT, { durable: handle });
    // The property the whole seam rests on: a nested dispatch picks the handle
    // up with no per-module effort, so a sequence two levels down journals under
    // the outer step's path. A rebuild site that dropped it would leave those
    // steps silently unjournaled.
    const nested = deriveContext(durable, { invocationId: 7 });
    expect(nested.durable).toBe(handle);
  });
});
