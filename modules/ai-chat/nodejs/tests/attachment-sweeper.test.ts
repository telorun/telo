import { describe, expect, it } from "vitest";
import { create } from "../src/attachment-sweeper-controller.js";

/** A store's released files and the blob keys it holds, behind the three operations a pass calls. */
function endpoint(released: string[], failOnce?: string) {
  const blobs = new Set(released.map((id) => `attachments/${id}`));
  const rows = new Set(released);
  let failing = failOnce;
  const op = (invoke: (inputs: any) => unknown) => ({ invoke: async (inputs: any) => invoke(inputs) });
  const resource = {
    metadata: { name: "expiry" },
    conversation: { provide: async () => ({ operations: [] }), pendingRetentionMs: () => 1000 },
    expire: op(({ limit }) => ({ ids: [...rows].slice(0, limit) })),
    forget: op(({ ids }) => {
      for (const id of ids) rows.delete(id);
      return {};
    }),
    blobDelete: op(({ key }) => {
      if (key === `attachments/${failing}`) {
        failing = undefined;
        throw new Error("the disk is gone");
      }
      blobs.delete(key);
      return { key };
    }),
  };
  const ctx = {
    resolveRef: (value: unknown) => value,
    invokeResolved: (kind: string, name: string, instance: any, inputs: any, invokeCtx: unknown) =>
      instance.invoke(inputs, invokeCtx),
  };
  return { resource, ctx, blobs, rows };
}

describe("an attachment expiry pass", () => {
  it("fails on a removal it cannot make, and the next pass finishes the job", async () => {
    const { resource, ctx, blobs, rows } = endpoint(["att_a", "att_b"], "att_b");
    const pass = await create(resource as never, ctx as never);
    await expect(pass.invoke({}, undefined)).rejects.toThrow("the disk is gone");
    expect([...rows]).toEqual(["att_a", "att_b"]);
    expect(await pass.invoke({}, undefined)).toEqual({ count: 2 });
    expect([blobs.size, rows.size]).toEqual([0, 0]);
    expect(await pass.invoke({}, undefined)).toEqual({ count: 0 });
  });

  it("removes each file once when two run at once, and both succeed", async () => {
    const { resource, ctx, blobs, rows } = endpoint(["att_a", "att_b", "att_c"]);
    const [first, second] = await Promise.all([create(resource as never, ctx as never), create(resource as never, ctx as never)]);
    const outcomes = await Promise.allSettled([first.invoke({}, undefined), second.invoke({}, undefined)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect([blobs.size, rows.size]).toEqual([0, 0]);
  });
});
