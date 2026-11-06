import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/password-throttle-controller.js";

const directCtx = { resolveRef: (value: unknown) => value } as unknown as ResourceContext;

/** A budget of `limit` units per key, recording every call. */
function budgetSpy(limit: number) {
  const spent = new Map<string, number>();
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    spent,
    async invoke(inputs: { op: string; key: string; amount: number; reserved?: number }) {
      calls.push(inputs);
      const used = spent.get(inputs.key) ?? 0;
      if (inputs.op === "reserve") {
        if (used + inputs.amount > limit) return { allowed: false, remaining: 0, retryAfter: 60, reserved: 0 };
        spent.set(inputs.key, used + inputs.amount);
        return { allowed: true, remaining: limit - used - inputs.amount, retryAfter: 0, reserved: inputs.amount };
      }
      spent.set(inputs.key, used - (inputs.reserved ?? 0) + inputs.amount);
      return { settled: true, total: spent.get(inputs.key) };
    },
  };
}

function passwordsSpy() {
  const calls: unknown[] = [];
  return {
    calls,
    async invoke(inputs: { identifier: string; password: string }) {
      calls.push(inputs);
      return inputs.password === "right"
        ? { principal: { subject: inputs.identifier } }
        : { refused: true, reason: "mismatch" };
    },
  };
}

async function throttleOver(limit: number) {
  const budget = budgetSpy(limit);
  const passwords = passwordsSpy();
  const throttle = await create({ metadata: { name: "throttle" }, passwords, budget }, directCtx);
  return { throttle, budget, passwords };
}

describe("Protection.PasswordThrottle", () => {
  it("passes failures through until the budget is spent, then throttles without asking the checker", async () => {
    const { throttle, passwords } = await throttleOver(2);
    const wrong = { identifier: "alice", password: "wrong" };
    expect(await throttle.invoke(wrong)).toEqual({ refused: true, reason: "mismatch" });
    expect(await throttle.invoke(wrong)).toEqual({ refused: true, reason: "mismatch" });
    expect(await throttle.invoke(wrong)).toEqual({ refused: true, reason: "throttled" });
    expect(await throttle.invoke({ identifier: "alice", password: "right" })).toEqual({ refused: true, reason: "throttled" });
    expect(passwords.calls).toHaveLength(2);
  });

  it("settles a success to nothing, so successes spend no budget", async () => {
    const { throttle, budget } = await throttleOver(1);
    for (let i = 0; i < 3; i++) {
      expect(await throttle.invoke({ identifier: "alice", password: "right" })).toEqual({ principal: { subject: "alice" } });
    }
    expect([...budget.spent.values()]).toEqual([0]);
    expect(budget.calls.filter((call) => call.op === "settle")).toHaveLength(3);
  });

  it("keys the budget by a digest of the identifier, never the identifier itself", async () => {
    const { throttle, budget } = await throttleOver(5);
    await throttle.invoke({ identifier: "alice", password: "wrong" });
    expect(budget.calls[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(budget.calls[0].key).not.toContain("alice");
  });
});
