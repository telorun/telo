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
      activeTurnId: "other",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a 401 ERR_UNAUTHENTICATED as the agent requiring a token", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: "Unauthenticated.", code: "ERR_UNAUTHENTICATED" }));
    await expect(new AgentClient("http://agent").startTurn(CONVERSATION, "hi")).resolves.toMatchObject({
      kind: "refused",
      status: 401,
      code: "ERR_UNAUTHENTICATED",
      message: "This agent requires a token.",
    });
  });
});

describe("AgentClient with a token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends it as a bearer token on every request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/chat") ? json(200, { turnId: "t1" }) : json(200, { files: [], content: "" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient("http://agent", "tok");

    await client.startTurn(CONVERSATION, "hi");
    await client.workspaceTree();
    await client.readWorkspaceFile("a.yaml");
    await client.syncWorkspace([], []);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((call[1].headers as Record<string, string>).authorization).toBe("Bearer tok");
    }
  });
});

describe("AgentClient.capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an auth mode it does not know as the agent's own word", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        json(200, { agent: { name: "A", version: "1.0.0" }, prompt: { id: "ab12" }, auth: "mtls" }),
      ),
    );

    await expect(new AgentClient("http://agent").capabilities()).resolves.toMatchObject({
      identity: { auth: "mtls" },
    });
  });

  it("reads the identity, and an agent without the route as unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { agent: { name: "AuthoringAgent", version: "0.9.0" }, prompt: { id: "ab12" }, auth: "none" }),
      )
      .mockResolvedValueOnce(json(404, { error: "not found" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient("http://agent");

    await expect(client.capabilities()).resolves.toEqual({
      state: "known",
      identity: { name: "AuthoringAgent", version: "0.9.0", promptId: "ab12", auth: "none" },
    });
    await expect(client.capabilities()).resolves.toEqual({ state: "unavailable" });
  });
});
