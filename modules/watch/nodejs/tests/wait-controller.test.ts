import {
  Duration,
  ERR_INVOKE_CANCELLED,
  createCancellationSource,
  type OpenZoneAttributes,
  type ResourceContext,
} from "@telorun/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create as createStore } from "../src/memory-store-controller.js";
import { create as createWait } from "../src/wait-controller.js";

function context(zones: OpenZoneAttributes[] = []): ResourceContext {
  return {
    resolveRef: (value: unknown) => value,
    zoneAttributes: () => zones,
  } as unknown as ResourceContext;
}

describe("Watch.Wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases its waiter and rethrows the cancellation when its call is cancelled", async () => {
    const store = await createStore({ metadata: { name: "store" } });
    const wait = await createWait(
      { metadata: { name: "wait" }, store, maxTimeout: Duration.fromMilliseconds(30_000) },
      context(),
    );
    const source = createCancellationSource();

    const waiting = wait.invoke(
      { topic: "plan", after: 0, timeout: Duration.fromMilliseconds(30_000) },
      source.context,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    source.cancel("client disconnected");
    await expect(waiting).rejects.toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to wait inside a replayed zone", async () => {
    const store = await createStore({ metadata: { name: "store" } });
    const wait = await createWait(
      { metadata: { name: "wait" }, store, maxTimeout: Duration.fromMilliseconds(30_000) },
      context([
        {
          kind: "DurableLocal.Workflow",
          attributes: { replayed: "a resume returns recorded outcomes" },
        } as OpenZoneAttributes,
      ]),
    );

    await expect(
      wait.invoke({ topic: "plan", after: 0, timeout: Duration.fromMilliseconds(30_000) }),
    ).rejects.toMatchObject({ code: "ERR_WATCH_REPLAY_FORBIDDEN" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
