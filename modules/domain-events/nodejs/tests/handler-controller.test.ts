import { InvokeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/handler-controller.js";

function handlerWith(when: unknown) {
  const dispatched: unknown[] = [];
  const target = {
    invoke: async (inputs: unknown) => {
      dispatched.push(inputs);
      return {};
    },
  };
  const ctx = { expandValue: (value: unknown) => value };
  const resource = {
    metadata: { name: "OnSignUp" },
    when,
    invoke: target,
    inputs: {},
  };
  return { dispatched, handler: create(resource, ctx as never) };
}

describe("Domain.Handler", () => {
  it("runs its target when the predicate is true", async () => {
    const { dispatched, handler } = handlerWith(true);
    await (await handler).invoke({ id: 1 }, {} as never);
    expect(dispatched).toHaveLength(1);
  });

  it("skips its target when the predicate is false", async () => {
    const { dispatched, handler } = handlerWith(false);
    await (await handler).invoke({ id: 1 }, {} as never);
    expect(dispatched).toHaveLength(0);
  });

  it("refuses a non-boolean predicate result with ERR_PREDICATE_NOT_BOOLEAN", async () => {
    const { dispatched, handler } = handlerWith("yes");
    const err = await (await handler).invoke({ id: 1 }, {} as never).catch((e) => e);
    expect(err).toBeInstanceOf(InvokeError);
    expect((err as InvokeError).code).toBe("ERR_PREDICATE_NOT_BOOLEAN");
    expect(dispatched).toHaveLength(0);
  });
});
