import { describe, expect, it } from "vitest";
import {
  StepEngine,
  type DurableRunHandle,
  type InvokeContext,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

function context(): StepEngineContext {
  return {
    expandValue: (value: unknown) => value,
    invoke: async () => {
      throw new Error("unused: the body dispatches nothing");
    },
    invokeResolved: async () => {
      throw new Error("unused: the body dispatches nothing");
    },
    ensureKindRef: () => {
      throw new Error("unused: nothing is resolved");
    },
  } as unknown as StepEngineContext;
}

/** A run whose journal already holds `recorded` at the keys it lists. */
function replaying(recorded: Record<string, unknown>): InvokeContext {
  const durable = {
    runId: "run-1",
    decide: async (path: string, kind: string, compute: () => unknown) =>
      path in recorded ? recorded[path] : compute(),
  } as unknown as DurableRunHandle;
  return { durable } as InvokeContext;
}

const BODY = [{ name: "count", value: 3 }] as unknown as Step[];

async function run(invokeCtx?: InvokeContext, body = BODY): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = {};
  await new StepEngine(context(), { kind: "Sequence", resourceName: "body" }).executeSteps(
    body,
    steps,
    undefined,
    {},
    invokeCtx,
  );
  return steps;
}

describe("a literal value: step", () => {
  it("returns the double a journal recorded before literals read as ints, verbatim", async () => {
    expect(await run(replaying({}))).toEqual({ count: { result: 3n } });
    expect(await run(replaying({ "steps/count": 3 }))).toEqual({ count: { result: 3 } });
  });

  it("leaves an integral number outside int64 the double it is", async () => {
    const body = [
      { name: "huge", value: 1e30 },
      { name: "edge", value: 9223372036854775807 },
    ] as unknown as Step[];
    expect(await run(undefined, body)).toEqual({
      huge: { result: 1e30 },
      edge: { result: 9223372036854775807 },
    });
  });
});
