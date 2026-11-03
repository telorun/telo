import { InvokeError, type InvokeContext, type ResourceContext, type ZoneEntry } from "@telorun/sdk";
import { describe, expect, it, vi } from "vitest";
import { pinnedZone } from "../src/enqueue-zone.js";
import { ZonedEnqueue } from "../src/zoned-enqueue.js";

describe("QueueSql.Enqueue", () => {
  it("asks the kernel for its root zone and hands the store exactly that entry", async () => {
    const zone = { kind: "Sql.Transaction" } as unknown as ZoneEntry;
    const seen: (ZoneEntry | undefined)[] = [];
    const operation = {
      invoke: vi.fn(async (_inputs: unknown, invokeCtx?: InvokeContext) => {
        seen.push(pinnedZone(invokeCtx));
        return { id: "m-1", enqueued: true };
      }),
    };
    const caller = { cancellation: { isCancelled: false } } as unknown as InvokeContext;
    const ctx = { requireZone: vi.fn(() => zone) } as unknown as ResourceContext;
    const enqueue = new ZonedEnqueue(ctx, operation);
    await expect(enqueue.invoke({ message: {} }, caller)).resolves.toEqual({ id: "m-1", enqueued: true });
    expect(ctx.requireZone).toHaveBeenCalledWith(caller);
    expect(seen).toEqual([zone]);
    expect(pinnedZone(caller)).toBeUndefined();
  });

  it("stores nothing when the kernel finds no transaction", async () => {
    const refused = new InvokeError("ERR_ZONE_REQUIRED", "no Sql.Transaction zone open");
    const operation = { invoke: vi.fn() };
    const ctx = {
      requireZone: vi.fn(() => {
        throw refused;
      }),
    } as unknown as ResourceContext;
    await expect(new ZonedEnqueue(ctx, operation).invoke({ message: {} })).rejects.toBe(refused);
    expect(operation.invoke).not.toHaveBeenCalled();
  });
});
