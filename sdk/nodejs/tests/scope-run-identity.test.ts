import { describe, expect, it } from "vitest";
import {
  deriveContext,
  isKindRef,
  kindRef,
  StepEngine,
  UNCANCELLABLE_CONTEXT,
  type InvokeContext,
  type KindRef,
  type ScopeContext,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

/**
 * A step inside a scope run names the run by its identity on the dispatch it
 * issues — per dispatch, never inherited — so the runtime redacts the run's
 * sensitive values from that dispatch's trace payload.
 */
describe("a scope run's identity on a dispatch", () => {
  it("is carried by every step dispatch inside the scope", async () => {
    const sent: InvokeContext[] = [];
    const runIdentity = Object.freeze({});
    const instance = { invoke: async () => ({}) };
    const ctx = {
      expandValue: (value: unknown) => value,
      invoke: async () => ({}),
      invokeResolved: async (_k: string, _n: string, _i: unknown, _in: unknown, dispatchCtx: InvokeContext) => {
        sent.push(dispatchCtx);
        return {};
      },
      ensureKindRef: (value: unknown): KindRef => {
        if (isKindRef(value)) return value;
        throw new Error("no inline declarations here");
      },
    } as unknown as StepEngineContext;
    const scope = {
      getInstance: () => instance,
      run: async () => {},
      resources: {},
      runIdentity,
    } as unknown as ScopeContext;
    await new StepEngine(ctx, { kind: "Sequence", resourceName: "s" }).executeSteps(
      [{ name: "call", invoke: kindRef("Test.Target", "target"), inputs: {} } as Step],
      {},
      scope,
      {},
      UNCANCELLABLE_CONTEXT,
      undefined,
      "/steps",
    );
    expect(sent.map((c) => c.scopeRun)).toEqual([runIdentity]);
  });

  it("is dropped from a derived context", () => {
    const base = { ...UNCANCELLABLE_CONTEXT, scopeRun: {} };
    expect(deriveContext(base, {}).scopeRun).toBeUndefined();
  });
});
