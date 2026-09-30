import { describe, expect, it } from "vitest";
import {
  createCancellationSource,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  StepEngine,
  type InvokeContext,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

/** A host for a body assembled in code: every target below is a live instance,
 *  so nothing is resolved and `expandValue` can be identity. */
function context(): StepEngineContext {
  return {
    expandValue: (value: unknown) => value,
    invoke: async () => {
      throw new Error("unused: every target is a live instance");
    },
    invokeResolved: async () => {
      throw new Error("unused: every target is a live instance");
    },
    ensureKindRef: () => {
      throw new Error("unused: nothing is resolved");
    },
  } as unknown as StepEngineContext;
}

/** A `try:` whose body throws `failure` — after running `during`, if given —
 *  with `catch:` and `finally:` branches that record whether they ran. */
function guarded(failure: Error, invokeCtx?: InvokeContext, during?: () => void) {
  const ran: string[] = [];
  const target = (name: string, outcome?: Error) => ({
    invoke: async () => {
      ran.push(name);
      if (outcome) {
        during?.();
        throw outcome;
      }
      return {};
    },
  });
  const steps = [
    {
      name: "guard",
      try: [{ name: "attempt", invoke: target("attempt", failure) }],
      catch: [{ name: "recover", invoke: target("recover") }],
      finally: [{ name: "cleanup", invoke: target("cleanup") }],
    },
  ] as unknown as Step[];
  const run = () =>
    new StepEngine(context(), { kind: "Sequence", resourceName: "body" }).executeSteps(
      steps,
      {},
      undefined,
      {},
      invokeCtx,
    );
  return { run, ran };
}

describe("a try: step", () => {
  it("lets a cancellation of its own invocation through untouched, running neither catch: nor finally:", async () => {
    const source = createCancellationSource();
    const cancelled = new InvokeError(ERR_INVOKE_CANCELLED, "Request cancelled");
    const { run, ran } = guarded(cancelled, { cancellation: source.token }, () => source.cancel("stopped"));
    await expect(run()).rejects.toBe(cancelled);
    expect(ran).toEqual(["attempt"]);
  });

  it("catches an ERR_INVOKE_CANCELLED raised while its invocation is not cancelled", async () => {
    const source = createCancellationSource();
    const { run, ran } = guarded(new InvokeError(ERR_INVOKE_CANCELLED, "recorded"), {
      cancellation: source.token,
    });
    await run();
    expect(ran).toEqual(["attempt", "recover", "cleanup"]);
  });

  it("still hands every other failure to catch: and then runs finally:", async () => {
    const { run, ran } = guarded(new InvokeError("ERR_DOMAIN", "no"));
    await run();
    expect(ran).toEqual(["attempt", "recover", "cleanup"]);
  });
});
