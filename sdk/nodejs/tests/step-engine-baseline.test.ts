import { describe, expect, it } from "vitest";
import {
  StepEngine,
  type DurableBaseline,
  type DurableBody,
  type DurableRunHandle,
  type InvokeContext,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

/** Expressions are written as functions of the CEL scope, evaluated in place. */
function context(): StepEngineContext {
  return {
    expandValue: (value: unknown, scope: unknown) =>
      typeof value === "function" ? (value as (s: unknown) => unknown)(scope) : value,
  } as unknown as StepEngineContext;
}

type Scope = { steps: Record<string, { result: number }> };

const BODY = [
  { name: "n", value: () => 0 },
  {
    name: "loop",
    while: (s: Scope) => s.steps.n.result < 3,
    do: [{ name: "n", value: (s: Scope) => s.steps.n.result + 1 }],
  },
  {
    name: "guard",
    try: [{ name: "boom", throw: { code: "ERR_BOOM" } }],
    catch: [{ name: "handled", value: () => "caught" }],
  },
  { name: "check", if: () => true, then: [{ name: "done", value: () => "end" }] },
] as unknown as Step[];

/** A run whose journal starts empty: every decision is computed, and its path kept. */
function run(offers?: DurableBaseline[]) {
  const decided: string[] = [];
  const durable = {
    runId: "run-1",
    decide: async (path: string, kind: string, compute: () => unknown) => {
      decided.push(path);
      return compute();
    },
    writesInside: () => false,
    ...(offers && {
      baseline: (capture: () => DurableBaseline) => {
        offers.push(structuredClone(capture()));
        return Promise.resolve();
      },
    }),
  } as unknown as DurableRunHandle;
  return { decided, invokeCtx: { durable } as InvokeContext };
}

async function execute(invokeCtx: InvokeContext, durableBody?: DurableBody) {
  const steps: Record<string, unknown> = {};
  await new StepEngine(context(), { kind: "Workflow", resourceName: "body" }).executeSteps(
    BODY,
    steps,
    undefined,
    {},
    invokeCtx,
    undefined,
    undefined,
    durableBody,
  );
  return steps;
}

describe("a durable body's baselines", () => {
  it("is offered one after every step of the body, inside loop turns and branches, never in a catch:", async () => {
    const offers: DurableBaseline[] = [];
    await execute(run(offers).invokeCtx, {});
    expect(offers.map((offer) => offer.position)).toEqual([
      [{ step: "steps/n" }],
      [{ step: "steps/loop", branch: "do", turn: 0 }, { step: "steps/loop/do[0]/n" }],
      [{ step: "steps/loop", branch: "do", turn: 1 }, { step: "steps/loop/do[1]/n" }],
      [{ step: "steps/loop", branch: "do", turn: 2 }, { step: "steps/loop/do[2]/n" }],
      [{ step: "steps/loop" }],
      [{ step: "steps/guard" }],
      [{ step: "steps/check", branch: "then" }, { step: "steps/check/then/done" }],
      [{ step: "steps/check" }],
    ]);
    expect(offers[2]!.steps).toEqual({ n: { result: 2 } });
  });

  it("is never offered for a list that is not a durable body", async () => {
    const offers: DurableBaseline[] = [];
    await execute(run(offers).invokeCtx);
    expect(offers).toEqual([]);
  });

  it("resumes at the recorded position with its steps, deciding nothing before it", async () => {
    const { decided, invokeCtx } = run();
    const steps = await execute(invokeCtx, {
      resume: {
        position: [{ step: "steps/loop", branch: "do", turn: 1 }, { step: "steps/loop/do[1]/n" }],
        steps: { n: { result: 2 } },
      },
    });
    expect(decided).toEqual([
      "steps/loop/while[2]",
      "steps/loop/do[2]/n",
      "steps/loop/while[3]",
      "steps/guard/catch/handled",
      "steps/check/if",
      "steps/check/then/done",
    ]);
    expect(steps).toEqual({
      n: { result: 3 },
      handled: { result: "caught" },
      done: { result: "end" },
    });
  });

  it("refuses a position the body no longer has", async () => {
    await expect(
      execute(run().invokeCtx, { resume: { position: [{ step: "steps/gone" }], steps: {} } }),
    ).rejects.toMatchObject({ code: "ERR_JOURNAL_ENTRY_MISMATCH" });
  });

  it("refuses a position frame this runtime does not write", async () => {
    const position = [{ step: "steps/loop", branch: "do", turn: 0, lane: 2 }, { step: "steps/loop/do[0]/n" }];
    await expect(
      execute(run().invokeCtx, { resume: { position, steps: {} } as unknown as DurableBaseline }),
    ).rejects.toMatchObject({ code: "ERR_DURABLE_ENTRY_UNDECODABLE" });
  });

  it("refuses a baseline holding a member beyond position and steps", async () => {
    const position = [{ step: "steps/n" }];
    await expect(
      execute(run().invokeCtx, { resume: { position, steps: {}, extra: 1 } as unknown as DurableBaseline }),
    ).rejects.toMatchObject({ code: "ERR_DURABLE_ENTRY_UNDECODABLE" });
  });
});
