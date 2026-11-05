import { describe, expect, it } from "vitest";
import {
  appendFailureFrame,
  droppedFramesOf,
  errorValueOf,
  failureFrameLine,
  failureFramesOf,
  InvokeError,
  isKindRef,
  kindRef,
  raisedAtOf,
  RuntimeError,
  StepEngine,
  UNCANCELLABLE_CONTEXT,
  type InvokeContext,
  type KindRef,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

const frame = (name: string, pointer?: string) => ({ kind: "Test.Kind", name, ...(pointer === undefined ? {} : { pointer }) });

describe("a failure's frames", () => {
  it("are bounded at 64, the innermost kept and the cut counted", () => {
    const err = new InvokeError("X", "x");
    for (let i = 0; i < 100; i++) appendFailureFrame(err, () => frame(`r${i}`));
    expect(failureFramesOf(err)).toHaveLength(64);
    expect(failureFramesOf(err)[0]!.name).toBe("r0");
    expect(failureFramesOf(err)[63]!.name).toBe("r63");
    expect(droppedFramesOf(err)).toBe(36);
  });

  it("stay out of the error's JSON and out of what a catch reads", () => {
    const err = new InvokeError("X", "x");
    appendFailureFrame(err, () => frame("a"));
    expect(JSON.parse(JSON.stringify(err))).toEqual({ name: "InvokeError", code: "X" });
    expect(Object.keys(err)).not.toContain("frames");
  });

  it("render one line each: an empty pointer drops the hash, no position drops the parentheses", () => {
    expect(failureFrameLine({ kind: "Sql.Exec", name: "insertUser", pointer: "", position: { line: 58, column: 3 } }, "users/telo.yaml")).toBe(
      "at Sql.Exec.insertUser (users/telo.yaml:58:3)",
    );
    expect(failureFrameLine({ kind: "Telo.Sequence", name: "createUser", pointer: "/steps/1", position: { line: 40, column: 7 } }, "users/telo.yaml")).toBe(
      "at Telo.Sequence.createUser#/steps/1 (users/telo.yaml:40:7)",
    );
    expect(failureFrameLine({ kind: "Http.Api", name: "api", pointer: "/routes/3/handler" }, undefined)).toBe(
      "at Http.Api.api#/routes/3/handler",
    );
  });
});

describe("the error value written for a failure", () => {
  it("carries the Telo trace as text and frames, and no host stack for a coded failure", () => {
    const err = new InvokeError("ERR_SQL_CONSTRAINT", "duplicate");
    appendFailureFrame(err, () => ({ ...frame("insertUser", ""), module: "file:///app/users/telo.yaml", position: { line: 58, column: 3 } }));
    const value = errorValueOf(err, { file: (module) => module.replace("file:///app/", "") });
    expect(value).toEqual({
      type: "ERR_SQL_CONSTRAINT",
      message: "duplicate",
      stack: "at Test.Kind.insertUser (users/telo.yaml:58:3)",
      frames: [{ ...frame("insertUser", ""), module: "file:///app/users/telo.yaml", position: { line: 58, column: 3 } }],
    });
  });

  it("writes the host stack of an uncoded failure and of ERR_FATAL, on the entry that is one", () => {
    const wrapper = new RuntimeError("ERR_EXECUTION_FAILED", "failed");
    (wrapper as { cause?: unknown }).cause = new TypeError("boom");
    const value = errorValueOf(wrapper);
    expect(value.hostStack).toBeUndefined();
    expect(value.cause?.hostStack).toContain("TypeError: boom");

    expect(errorValueOf(new RuntimeError("ERR_FATAL", "invariant")).hostStack).toContain("invariant");
    expect(errorValueOf(new InvokeError("ERR_COMPUTED", "x")).hostStack).toBeUndefined();
  });
});

/** A host whose dispatches fail by the step's target name, recording the context each carried. */
function host(failing: Record<string, () => unknown>) {
  const sent: Record<string, InvokeContext | undefined> = {};
  const ctx = {
    expandValue: (value: unknown) => value,
    invoke: async (_kind: string, name: string, _inputs: unknown, options?: { ctx?: InvokeContext }) => {
      sent[name] = options?.ctx;
      const fail = failing[name];
      if (fail) throw fail();
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

async function run(ctx: StepEngineContext, steps: Step[]): Promise<unknown> {
  try {
    await new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      steps,
      {},
      undefined,
      {},
      UNCANCELLABLE_CONTEXT,
      undefined,
      "/steps",
    );
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("the step engine and a failure's trace", () => {
  it("states where each step is called, nested steps at their full path", async () => {
    const { ctx, sent } = host({});
    await run(ctx, [
      call("first"),
      { name: "attempt", try: [{ name: "fail", throw: { code: "X" } } as Step], catch: [call("caught")] } as Step,
    ]);
    expect(sent["first"]!.calledAt).toBe("/steps/0");
    expect(sent["caught"]!.calledAt).toBe("/steps/1/catch/0");
  });

  it("starts a fresh trace at a throw step, pointing at the step", async () => {
    const { ctx } = host({});
    const err = await run(ctx, [call("first"), { name: "refuse", throw: { code: "USER_EXISTS" } } as Step]);
    expect(raisedAtOf(err)).toBe("/steps/1");
    expect(failureFramesOf(err)).toEqual([]);
  });

  it("keeps the caught failure's frames on the cause of a throw in catch, and on a rethrow", async () => {
    const inner = new InvokeError("INNER", "inner");
    appendFailureFrame(inner, () => frame("insert", ""));
    const { ctx } = host({ insert: () => inner });

    const thrown = (await run(ctx, [
      { name: "attempt", try: [call("insert")], catch: [{ name: "again", throw: { code: "OUTER" } } as Step] } as Step,
    ])) as InvokeError;
    expect(raisedAtOf(thrown)).toBe("/steps/0/catch/0");
    expect(failureFramesOf(thrown)).toEqual([]);
    expect(failureFramesOf(thrown.cause)).toEqual([frame("insert", "")]);

    const rethrown = await run(ctx, [
      { name: "attempt", try: [call("insert")], catch: [{ name: "again", rethrow: {} } as Step] } as Step,
    ]);
    expect(rethrown).toBe(inner);
    expect(failureFramesOf(rethrown)).toEqual([frame("insert", "")]);
  });

  it("raises the last attempt's frames when a retry gives up", async () => {
    let attempts = 0;
    const { ctx } = host({
      insert: () => {
        const failure = new InvokeError("FLAKY", `attempt ${++attempts}`);
        appendFailureFrame(failure, () => frame(`attempt${attempts}`));
        return failure;
      },
    });
    const err = await run(ctx, [
      { name: "insert", invoke: kindRef("Test.Target", "insert"), inputs: {}, retry: { attempts: 2, initialDelay: 1, maxDelay: 1, jitter: "none" } } as unknown as Step,
    ]);
    expect(attempts).toBe(3);
    expect(failureFramesOf(err).map((f) => f.name)).toEqual(["attempt3"]);
  });

  it("does not hand a catch the trace", async () => {
    const inner = new InvokeError("INNER", "inner");
    appendFailureFrame(inner, () => frame("insert", ""));
    const { ctx } = host({ insert: () => inner });
    let seen: Record<string, unknown> | undefined;
    const spying = {
      ...ctx,
      expandValue: (value: unknown, scope?: Record<string, unknown>) => {
        if (scope && "error" in scope && scope["error"]) seen = scope["error"] as Record<string, unknown>;
        return value;
      },
    } as unknown as StepEngineContext;
    await run(spying, [
      { name: "attempt", try: [call("insert")], catch: [{ name: "log", value: "x" } as Step] } as Step,
    ]);
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("frames");
  });
});
