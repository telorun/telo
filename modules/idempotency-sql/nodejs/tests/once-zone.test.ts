import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { describe, expect, it, vi } from "vitest";
import { create } from "../src/once.js";

describe("IdempotencySql.Once", () => {
  it("asks the kernel for its root zone before recording, and records nothing without one", async () => {
    const record = vi.fn();
    const body = { invoke: vi.fn() };
    const refused = new InvokeError("ERR_ZONE_REQUIRED", "no SQL.Transaction zone open");
    const ctx = {
      resolveRef: () => ({ name: "orders", record }),
      requireZone: vi.fn(() => {
        throw refused;
      }),
    } as unknown as ResourceContext;
    const once = await create(
      { kind: "IdempotencySql.Once", metadata: { name: "chargeOnce" }, ledger: {}, invoke: body },
      ctx,
    );
    await expect(once.invoke({ key: "order-1" })).rejects.toBe(refused);
    expect(ctx.requireZone).toHaveBeenCalledWith(undefined);
    expect(record).not.toHaveBeenCalled();
    expect(body.invoke).not.toHaveBeenCalled();
  });
});
