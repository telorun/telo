import { describe, expect, it } from "vitest";
import {
  anchorableInputPointer,
  attachLocation,
  deriveContext,
  InvokeError,
  isKindRef,
  kindRef,
  StepEngine,
  stampRefIdentity,
  toSequenceError,
  UNCANCELLABLE_CONTEXT,
  type InvokeContext,
  type KindRef,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

describe("an InvokeError's input pointer and location", () => {
  it("keeps both out of its JSON and out of the error a catch reads", () => {
    const err = new InvokeError("ERR_ASSERTION_FAILED", "differs", { a: 1 }, { inputPointer: "/expected/rows" });
    attachLocation(err, { kind: "Run.Sequence", name: "check", module: "file:///app/telo.yaml", pointer: "/steps/1/inputs" });

    expect(err.inputPointer).toBe("/expected/rows");
    expect(JSON.parse(JSON.stringify(err))).toEqual({ name: "InvokeError", code: "ERR_ASSERTION_FAILED", data: { a: 1 } });
    expect(toSequenceError(err, "s")).toEqual({
      message: "differs",
      code: "ERR_ASSERTION_FAILED",
      data: { a: 1 },
      step: "s",
      displayMessage: null,
    });
  });

  it("keeps the first location attached", () => {
    const err = new InvokeError("X", "x");
    attachLocation(err, { kind: "Run.Sequence", name: "inner" });
    attachLocation(err, { kind: "Run.Sequence", name: "outer", pointer: "/steps/0/inputs" });
    expect(err.location).toEqual({ kind: "Run.Sequence", name: "inner" });
  });
});

describe("a derived context", () => {
  it("drops the per-dispatch inputsAt unless the override states it", () => {
    const base = deriveContext(UNCANCELLABLE_CONTEXT, { inputsAt: "/steps/0/inputs", durablePath: "steps/a" });
    expect(deriveContext(base, { traceId: "t" })).toEqual({
      cancellation: UNCANCELLABLE_CONTEXT.cancellation,
      durablePath: "steps/a",
      traceId: "t",
    });
    expect(deriveContext(base, { inputsAt: "/steps/1/inputs" }).inputsAt).toBe("/steps/1/inputs");
  });
});

/** A host recording the context each dispatch by name carries. */
function host() {
  const sent: Record<string, string | undefined> = {};
  const ctx = {
    expandValue: (value: unknown) => value,
    invoke: async (kind: string, name: string, inputs: unknown, options?: { ctx?: InvokeContext }) => {
      sent[name] = options?.ctx?.inputsAt;
      return {};
    },
    invokeResolved: async () => ({}),
    ensureKindRef: (value: unknown): KindRef => {
      if (isKindRef(value)) return value;
      throw new Error("no inline declarations here");
    },
  } as unknown as StepEngineContext;
  return { ctx, sent };
}

const call = (name: string): Step => ({ name, invoke: kindRef("Test.Target", name), inputs: {} }) as Step;

describe("the step engine", () => {
  const body = (): Step[] => [
    call("first"),
    {
      name: "branch",
      if: false,
      then: [call("never")],
      elseif: [{ if: true, then: [call("chosen")] }],
    } as Step,
    { name: "pick", switch: "a/b~c", cases: { "a/b~c": [call("cased")] } } as Step,
    { name: "attempt", try: [{ name: "fail", throw: { code: "X" } } as Step], catch: [call("caught")] } as Step,
  ];

  it("sends where each invoke step's inputs are written, branches included", async () => {
    const { ctx, sent } = host();
    await new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      body(),
      {},
      undefined,
      {},
      UNCANCELLABLE_CONTEXT,
      undefined,
      "/steps",
    );
    expect(sent).toEqual({
      first: "/steps/0/inputs",
      chosen: "/steps/1/elseif/0/then/0/inputs",
      cased: "/steps/2/cases/a~1b~0c/0/inputs",
      caught: "/steps/3/catch/0/inputs",
    });
  });

  it("sends none when the caller names no written place, not even the one it was called with", async () => {
    const { ctx, sent } = host();
    await new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      body(),
      {},
      undefined,
      {},
      { ...UNCANCELLABLE_CONTEXT, inputsAt: "/steps/9/inputs" },
    );
    expect(Object.values(sent)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("a step calling an instance no dispatch identifies", () => {
  it("rethrows the failure with its pointer marked unanchorable, and sends no inputsAt", async () => {
    const raised = new InvokeError("ERR_ASSERTION_FAILED", "differs", undefined, { inputPointer: "/expected" });
    let received: InvokeContext | undefined;
    const anonymous = {
      invoke: async (inputs: unknown, invokeCtx: InvokeContext) => {
        received = invokeCtx;
        throw raised;
      },
    };
    const { ctx } = host();
    const run = new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      [{ name: "direct", invoke: anonymous, inputs: {} } as unknown as Step],
      {},
      undefined,
      {},
      { ...UNCANCELLABLE_CONTEXT, inputsAt: "/steps/9/inputs" },
      undefined,
      "/steps",
    );

    await expect(run).rejects.toBe(raised);
    expect(received?.inputsAt).toBeUndefined();
    expect(anchorableInputPointer(raised)).toBeUndefined();
  });

  it("leaves the pointer anchorable for a stamped instance, which the kernel dispatches", async () => {
    const raised = new InvokeError("ERR_ASSERTION_FAILED", "differs", undefined, { inputPointer: "/expected" });
    const stamped = { invoke: async () => ({}) };
    stampRefIdentity(stamped, "Assert.Equals", "equals");
    let sent: string | undefined;
    const { ctx } = host();
    (ctx as { invokeResolved: unknown }).invokeResolved = async (
      kind: string,
      name: string,
      instance: unknown,
      inputs: unknown,
      invokeCtx?: InvokeContext,
    ) => {
      sent = invokeCtx?.inputsAt;
      throw raised;
    };
    const run = new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      [{ name: "check", invoke: stamped, inputs: {} } as unknown as Step],
      {},
      undefined,
      {},
      UNCANCELLABLE_CONTEXT,
      undefined,
      "/steps",
    );

    await expect(run).rejects.toBe(raised);
    expect(sent).toBe("/steps/0/inputs");
    expect(anchorableInputPointer(raised)).toBe("/expected");
  });
});
