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

describe("AgentClient.revertTurn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resends a revert the agent refused with 503 ERR_WORKSPACE_BUSY", async () => {
    const revert = { revertedAt: "2026-09-30T10:00:00.000Z", files: [{ path: "a.yaml", status: "modified", outcome: "restored" }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(503, { error: "The workspace is busy.", code: "ERR_WORKSPACE_BUSY" }))
      .mockResolvedValueOnce(json(200, { revert, revision: 8 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = new AgentClient("http://agent").revertTurn("t1");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ revert, revision: 8 });
    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`)).toEqual([
      "POST http://agent/chat/t1/revert",
      "POST http://agent/chat/t1/revert",
    ]);
  });
});

describe("AgentClient.workspaceTree", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an answer carrying no file list, and reads an empty list as an empty tree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(200, {})).mockResolvedValueOnce(json(200, { files: [] })));
    const client = new AgentClient("http://agent");

    await expect(client.workspaceTree()).rejects.toThrow("GET /workspace returned no file list.");
    await expect(client.workspaceTree()).resolves.toEqual([]);
  });
});

describe("AgentClient attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the capability document's limits, and a refusal in the server's own envelope by its code", async () => {
    const limits = { maxBytes: 1024, maxPerMessage: 10, mediaTypes: ["image/png", "text/*"] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { agent: {}, prompt: {}, auth: "none", features: ["attachments"], attachments: limits }))
      .mockResolvedValueOnce(
        json(413, { error: { code: "ERR_REQUEST_BODY_TOO_LARGE", message: "body too large", data: { maxBytes: 1024 } } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient("http://agent.test", "secret");

    expect(await client.capabilities()).toMatchObject({ state: "known", identity: { attachments: limits } });
    await expect(client.uploadAttachment(CONVERSATION, new Blob(["x"]), "a.png", "image/png")).rejects.toMatchObject({
      status: 413,
      code: "ERR_REQUEST_BODY_TOO_LARGE",
      details: { maxBytes: 1024 },
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`http://agent.test/conversations/${CONVERSATION}/attachments`);
    expect(init.headers).toEqual({ authorization: "Bearer secret" });
  });

  it("reads an attachment's bytes with the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bytes", { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await new AgentClient("http://agent.test", "secret").attachmentBytes(CONVERSATION, "a1");

    expect(blob.size).toBe(5);
    expect(fetchMock.mock.calls[0]).toEqual([
      `http://agent.test/conversations/${CONVERSATION}/attachments/a1`,
      { headers: { authorization: "Bearer secret" } },
    ]);
  });
});
