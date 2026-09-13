import { describe, expect, it } from "vitest";
import {
  resolveInvocableDispatcher,
  stampRefIdentity,
  type DispatchContext,
  type InvokeContext,
  type KindRef,
  type ModuleContext,
  type ResourceInstance,
} from "../src/index.js";

/** A host that records what reaches the traced chokepoint, and fails loudly if
 *  a slot value is handed to `ensureKindRef` that should never reach it. */
function host(registered: Record<string, unknown> = {}) {
  const dispatched: { kind: string; name: string; instance: unknown; inputs: unknown; ctx: unknown }[] = [];
  const normalized: unknown[] = [];
  const ctx: DispatchContext = {
    moduleContext: {
      getInstance: (name: string) => registered[name],
      resolveImportedInstance: () => undefined,
    } as unknown as ModuleContext,
    invokeResolved: async (kind, name, instance, inputs, invokeCtx) => {
      dispatched.push({ kind, name, instance, inputs, ctx: invokeCtx });
      return typeof (instance as { invoke?: unknown }).invoke === "function"
        ? (instance as { invoke: (i: unknown) => unknown }).invoke(inputs)
        : (instance as { run: () => unknown }).run();
    },
    ensureKindRef(value: unknown): KindRef {
      normalized.push(value);
      const declared = value as { kind?: string; name?: string };
      if (!declared.kind) throw new Error("Resource must have 'kind' property.");
      return { kind: declared.kind, name: declared.name ?? "inline" } as KindRef;
    },
  };
  return { ctx, dispatched, normalized };
}

const describeOwner = () => `Stream.Tap "printed"`;
const invokeCtx = { cancellation: { isCancelled: false } } as unknown as InvokeContext;

describe("resolveInvocableDispatcher", () => {
  it("dispatches an injected run-only target through the chokepoint, as a step does", async () => {
    let runs = 0;
    const probe = { run: async () => void runs++ } as unknown as ResourceInstance;
    stampRefIdentity(probe, "Assert.Events", "probe");
    const { ctx, dispatched, normalized } = host();

    const dispatch = resolveInvocableDispatcher(probe, ctx, describeOwner);
    await dispatch({ item: "a" }, invokeCtx);

    expect(runs).toBe(1);
    expect(normalized).toEqual([]);
    expect(dispatched).toEqual([
      { kind: "Assert.Events", name: "probe", instance: probe, inputs: { item: "a" }, ctx: invokeCtx },
    ]);
  });

  it("resolves a raw reference to a run-only target", async () => {
    let runs = 0;
    const probe = { run: async () => void runs++ } as unknown as ResourceInstance;
    const { ctx, dispatched } = host({ probe });

    const dispatch = resolveInvocableDispatcher({ kind: "Assert.Events", name: "probe" }, ctx, describeOwner);
    await dispatch({}, invokeCtx);

    expect(runs).toBe(1);
    expect(dispatched.map((d) => [d.kind, d.name])).toEqual([["Assert.Events", "probe"]]);
  });

  it("starts an anonymous run-only instance with run(), passing the context", async () => {
    const seen: unknown[] = [];
    const anonymous = { run: async (c?: InvokeContext) => void seen.push(c) } as unknown as ResourceInstance;
    const { ctx, dispatched } = host();

    await resolveInvocableDispatcher(anonymous, ctx, describeOwner)({ ignored: true }, invokeCtx);

    expect(seen).toEqual([invokeCtx]);
    expect(dispatched).toEqual([]);
  });

  it("still dispatches an invocable target with its inputs", async () => {
    const received: unknown[] = [];
    const handler = { invoke: async (i: unknown) => received.push(i) } as unknown as ResourceInstance;
    stampRefIdentity(handler, "Console.Write", "write");
    const { ctx } = host();

    await resolveInvocableDispatcher(handler, ctx, describeOwner)({ output: "x" }, invokeCtx);

    expect(received).toEqual([{ output: "x" }]);
  });

  it("refuses an injected instance that can be neither invoked nor run, naming the owner and slot", () => {
    const store = { get: async () => undefined } as unknown as ResourceInstance;
    stampRefIdentity(store, "Cache.MemoryStore", "store");
    const { ctx, normalized } = host();

    expect(() => resolveInvocableDispatcher(store, ctx, describeOwner)).toThrowError(
      `Stream.Tap "printed": 'invoke' references 'store' (Cache.MemoryStore), which has neither ` +
        `invoke() nor run() and cannot be dispatched. Reference an invocable or runnable resource.`,
    );
    expect(normalized).toEqual([]);
  });

  it("refuses a reference that resolves to something that is not executable", () => {
    const { ctx } = host({ store: { get: async () => undefined } });

    expect(() =>
      resolveInvocableDispatcher({ kind: "Cache.MemoryStore", name: "store" }, ctx, describeOwner),
    ).toThrowError(
      `Stream.Tap "printed": 'invoke' reference 'store' did not resolve to a resource satisfying ` +
        "`Telo.Executable`.",
    );
  });

  it("refuses an absent slot with the owner and slot named", () => {
    const { ctx } = host();

    expect(() => resolveInvocableDispatcher(undefined, ctx, describeOwner)).toThrowError(
      `Stream.Tap "printed": 'invoke' is required — reference a resource satisfying \`Telo.Executable\`.`,
    );
  });
});
