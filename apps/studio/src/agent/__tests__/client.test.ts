import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentClient } from "../client";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The Idempotency-Key each POST /chat carried, in call order. */
function keysSent(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["idempotency-key"],
  );
}

const CONVERSATION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("AgentClient.startTurn", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("repeats one key across a retried 503", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("warming up", { status: 503 }))
      .mockResolvedValueOnce(json(200, { turnId: "t1" }));
    const pending = new AgentClient("http://agent").startTurn(CONVERSATION, "hi");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ kind: "started", turnId: "t1" });
    const keys = keysSent(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key for each send", async () => {
    fetchMock.mockImplementation(async () => json(200, { turnId: "t" }));
    const client = new AgentClient("http://agent");
    await client.startTurn(CONVERSATION, "one");
    await client.startTurn(CONVERSATION, "two");

    const [first, second] = keysSent(fetchMock);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("retries ERR_IDEMPOTENCY_KEY_IN_FLIGHT with the same key", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(409, { error: "still being admitted", code: "ERR_IDEMPOTENCY_KEY_IN_FLIGHT" }),
      )
      .mockResolvedValueOnce(json(200, { turnId: "t1" }));
    const pending = new AgentClient("http://agent").startTurn(CONVERSATION, "hi");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ kind: "started", turnId: "t1" });
    const keys = keysSent(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("reports a refusal by the code its body carries", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { error: "busy", code: "ERR_TURN_IN_PROGRESS", activeTurnId: "other" }),
    );
    await expect(new AgentClient("http://agent").startTurn(CONVERSATION, "hi")).resolves.toEqual({
      kind: "refused",
      status: 409,
      code: "ERR_TURN_IN_PROGRESS",
      message: "busy",
      retryAfter: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
