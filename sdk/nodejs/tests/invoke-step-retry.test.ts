import { describe, expect, it } from "vitest";
import {
  createCancellationSource,
  ERR_INPUT_INVALID,
  ERR_INVOKE_CANCELLED,
  executeInvokeStep,
  InvokeError,
  type InvokeStep,
  type InvokeStepContext,
  type InvokeStepState,
} from "../src/index.js";

/** The leaf needs nothing else from the kernel, which is what lets a step be
 *  driven here with no kernel at all. `expandValue` is identity: these tests are
 *  about the retry loop, not about CEL. */
function fakeContext(): InvokeStepContext {
  return {
    expandValue: (value: unknown) => value,
    invoke: async () => {
      throw new Error("unused: the step under test carries a live instance");
    },
    invokeResolved: async () => {
      throw new Error("unused: the step under test carries a live instance");
    },
  };
}

/** A step whose target is an anonymous live instance — the branch that calls the
 *  instance directly, so `calls` counts attempts exactly. */
function stepCalling(
  behaviour: (attempt: number) => unknown,
  retry?: InvokeStep["retry"],
): { step: InvokeStep; calls: () => number } {
  let calls = 0;
  const step: InvokeStep = {
    name: "Target",
    invoke: {
      invoke: async () => {
        calls += 1;
        const outcome = behaviour(calls);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as unknown as InvokeStep["invoke"],
    ...(retry ? { retry } : {}),
  };
  return { step, calls: () => calls };
}

function state(extra?: Partial<InvokeStepState>): InvokeStepState {
  return { steps: {}, ...extra };
}

describe("step retry", () => {
  it("re-attempts a domain failure up to the budget and no further", async () => {
    const { step, calls } = stepCalling(
      (attempt) => (attempt < 3 ? new Error(`attempt ${attempt}`) : { ok: attempt }),
      { attempts: 3, initialDelay: 1, jitter: "none" },
    );
    const s = state();
    await executeInvokeStep(step, fakeContext(), s);

    expect(calls()).toBe(3);
    expect(s.steps.Target).toEqual({ result: { ok: 3 } });
  });

  it("propagates the failure once the budget is exhausted", async () => {
    const { step, calls } = stepCalling(() => new Error("always"), {
      attempts: 2,
      initialDelay: 1,
      jitter: "none",
    });

    await expect(executeInvokeStep(step, fakeContext(), state())).rejects.toThrow("always");
    // attempts counts RE-attempts, so the budget is attempts + 1 calls.
    expect(calls()).toBe(3);
  });

  it("does not re-attempt a contract violation", async () => {
    // A property of the manifest rather than of the work: every re-attempt would
    // fail identically, so the budget is spent between a typo and its diagnostic.
    const { step, calls } = stepCalling(
      () => new InvokeError(ERR_INPUT_INVALID, "inputs do not satisfy inputType"),
      { attempts: 5, initialDelay: 1, jitter: "none" },
    );

    await expect(executeInvokeStep(step, fakeContext(), state())).rejects.toThrow(
      "inputs do not satisfy inputType",
    );
    expect(calls()).toBe(1);
  });

  it("does not re-attempt a cancelled dispatch", async () => {
    const { step, calls } = stepCalling(
      () => new InvokeError(ERR_INVOKE_CANCELLED, "Invoke cancelled"),
      { attempts: 5, initialDelay: 1, jitter: "none" },
    );

    await expect(executeInvokeStep(step, fakeContext(), state())).rejects.toThrow(
      "Invoke cancelled",
    );
    expect(calls()).toBe(1);
  });

  it("abandons the backoff when the invocation is cancelled", async () => {
    // The wait is the one interval a cancelled run would otherwise sit out: every
    // step boundary is already a cancellation point, because the kernel refuses a
    // dispatch reached after the tree was cancelled, but a backoff is time spent
    // inside the leaf where that gate cannot see it.
    const source = createCancellationSource();
    const { step, calls } = stepCalling(() => new Error("always"), {
      attempts: 5,
      initialDelay: 30_000,
      jitter: "none",
    });

    const started = Date.now();
    const running = executeInvokeStep(step, fakeContext(), state({ invokeCtx: source.context }));
    setTimeout(() => source.cancel("test asked it to stop"), 20);

    await expect(running).rejects.toMatchObject({ code: ERR_INVOKE_CANCELLED });
    // Far below the 30s backoff it was parked in, and with no second attempt.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls()).toBe(1);
  });

  it("carries the failure that caused the wait into the cancellation", async () => {
    // Otherwise cancelling mid-backoff reports only that the run stopped, and the
    // error being retried — the thing the author cares about — is gone.
    const source = createCancellationSource();
    const { step } = stepCalling(() => new InvokeError("ERR_UPSTREAM", "upstream said 503"), {
      attempts: 5,
      initialDelay: 30_000,
      jitter: "none",
    });

    const running = executeInvokeStep(step, fakeContext(), state({ invokeCtx: source.context }));
    setTimeout(() => source.cancel(), 20);

    await expect(running).rejects.toMatchObject({
      code: ERR_INVOKE_CANCELLED,
      data: {
        step: "Target",
        pendingFailure: { code: "ERR_UPSTREAM", message: "upstream said 503" },
      },
    });
  });

  it("waits out the backoff when no invocation context was forwarded", async () => {
    // A caller that assembled a step in code has no invocation to forward, so an
    // absent context must degrade to an ordinary wait rather than a broken loop.
    const { step, calls } = stepCalling(
      (attempt) => (attempt < 2 ? new Error("first") : { ok: true }),
      { attempts: 1, initialDelay: 5, jitter: "none" },
    );

    await executeInvokeStep(step, fakeContext(), state());
    expect(calls()).toBe(2);
  });

  it("rejects a malformed legacy `delay` rather than silently defaulting", async () => {
    const { step } = stepCalling(() => new Error("always"), {
      attempts: 1,
      delay: "1x",
      jitter: "none",
    });

    await expect(executeInvokeStep(step, fakeContext(), state())).rejects.toThrow(
      /invalid 'delay'/,
    );
  });

  it("reads the legacy `delay` as the initial wait when `initialDelay` is absent", async () => {
    const { step, calls } = stepCalling(
      (attempt) => (attempt < 2 ? new Error("first") : { ok: true }),
      { attempts: 1, delay: "5ms", jitter: "none" },
    );

    await executeInvokeStep(step, fakeContext(), state());
    expect(calls()).toBe(2);
  });
});

describe("step retry — unretryable kernel verdicts", () => {
  it.each([
    ["ERR_RESOURCE_NOT_FOUND", "no resource named 'Typo'"],
    ["ERR_RESOURCE_NOT_INVOKABLE", "'Server' is not invocable"],
  ])("does not re-attempt %s", async (code, message) => {
    // A misspelled target does not become spelled correctly after eight seconds
    // of backoff — the same reasoning that excludes a contract violation.
    const { step, calls } = stepCalling(() => new InvokeError(code, message), {
      attempts: 5,
      initialDelay: 1,
      jitter: "none",
    });

    await expect(executeInvokeStep(step, fakeContext(), state())).rejects.toThrow(message);
    expect(calls()).toBe(1);
  });
});
