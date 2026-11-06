import type { ResourceContext } from "@telorun/sdk";
import { DurableSuspension, ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/recover-controller.js";

/** A source yielding `values`, then failing with `error`. */
async function* failing(values: unknown[], error: unknown): AsyncIterable<unknown> {
  yield* values;
  throw error;
}

/** A Recover whose `value` / `when` are evaluated by `evaluate`, standing in for
 *  the kernel's CEL over the `error` binding. */
async function recover(options: { when?: (error: any) => unknown } = {}) {
  const logged: unknown[] = [];
  const ctx = {
    log: { error: (message: string, context: unknown, attributes: unknown) => logged.push({ message, attributes }) },
    expandValue: (value: unknown, bindings: { error: any }) =>
      value === "WHEN" ? options.when!(bindings.error) : { recovered: bindings.error.code },
  } as unknown as ResourceContext;
  const instance = await create(
    { metadata: { name: "ending" }, value: "VALUE", ...(options.when ? { when: "WHEN" } : {}) },
    ctx,
  );
  return { instance, logged };
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("Stream.Recover", () => {
  it("logs the failure it absorbs", async () => {
    const failure = new InvokeError("ERR_UPSTREAM", "upstream broke");
    const { instance, logged } = await recover();
    const { output } = await instance.invoke({ input: failing([1], failure) });
    expect(await drain(output)).toEqual([1, { recovered: "ERR_UPSTREAM" }]);
    expect(logged).toEqual([{ message: expect.any(String), attributes: { error: failure } }]);
  });

  it("rethrows a failure its condition declines, logging nothing", async () => {
    const failure = new InvokeError("ERR_UPSTREAM", "upstream broke");
    const { instance, logged } = await recover({ when: (error) => error.code !== "ERR_UPSTREAM" });
    const { output } = await instance.invoke({ input: failing([1], failure) });
    await expect(drain(output)).rejects.toBe(failure);
    expect(logged).toEqual([]);
  });

  it("refuses a condition that is not a boolean", async () => {
    const { instance } = await recover({ when: () => "yes" });
    const { output } = await instance.invoke({ input: failing([], new Error("plain")) });
    await expect(drain(output)).rejects.toMatchObject({ code: "ERR_INVALID_VALUE" });
  });

  it("never absorbs a cancellation or a suspension", async () => {
    const cancelled = new InvokeError(ERR_INVOKE_CANCELLED, "cancelled");
    const suspension = new DurableSuspension("run", "steps/wait", "wait", { at: 0 } as never);
    for (const failure of [cancelled, suspension]) {
      const { instance, logged } = await recover({ when: () => true });
      const { output } = await instance.invoke({ input: failing([], failure) });
      await expect(drain(output)).rejects.toBe(failure);
      expect(logged).toEqual([]);
    }
  });
});
