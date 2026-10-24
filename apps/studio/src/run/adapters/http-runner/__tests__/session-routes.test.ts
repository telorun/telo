import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeSecretCredentials } from "../../../runner-credentials";
import { SessionGoneError, TeloVersionRefusedError, TermsRequiredError } from "../../../types";
import { createHttpRunnerAdapter } from "../factory";

const BASE = "http://runner.test";

const adapter = createHttpRunnerAdapter<{ baseUrl: string; image?: string; region?: string }>({
  id: "http-runner",
  displayName: "HTTP runner",
  description: "",
  configSchema: {},
  defaultConfig: { baseUrl: BASE },
  startTimeoutMs: 1000,
  buildRequestConfig: (config) => Object.fromEntries(Object.entries(config).filter(([key]) => key !== "baseUrl")),
});

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function stub(...answers: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const a of answers) fetchMock.mockResolvedValueOnce(a);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof stub>, index: number) {
  const [url, init] = fetchMock.mock.calls[index]!;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("creating a session", () => {
  it("sends the workspace, its apps, the agent and the config a version leaves, and answers the secret", async () => {
    const fetchMock = stub(answer(201, { sessionId: "s1", streamUrl: "/v1/sessions/s1/events", resumeSecret: "sek" }));
    const connection = await adapter.connect({ baseUrl: BASE, image: "x", region: "eu" });
    const created = await connection.createSession(
      { workspace: "w", agent: "authoring-agent", apps: [{ name: "api", entryRelativePath: "api/telo.yaml", telo: "0.122.0" }] },
      { acceptedTermsVersion: "v2", withheldConfig: ["image"] },
    );
    expect(created).toEqual({ kind: "created", sessionId: "s1", resumeSecret: "sek" });
    expect(call(fetchMock, 0)).toEqual({
      url: `${BASE}/v1/sessions`,
      method: "POST",
      headers: { "content-type": "application/json", "x-telo-accepted-terms": "v2" },
      body: {
        workspace: "w",
        apps: [{ name: "api", entryRelativePath: "api/telo.yaml", telo: "0.122.0" }],
        config: { region: "eu" },
        agent: "authoring-agent",
      },
    });
  });

  it("answers an existing session's id, and carries the runner's refusals as their own errors", async () => {
    const connection = await adapter.connect({ baseUrl: BASE });
    const request = { workspace: "w", apps: [] };
    stub(answer(409, { error: "session_exists", message: "exists", sessionId: "s9" }));
    expect(await connection.createSession(request, {})).toEqual({ kind: "exists", sessionId: "s9" });

    stub(answer(428, { error: "terms_required", terms: { version: "v3", title: "T", body: "B" } }));
    await expect(connection.createSession(request, {})).rejects.toBeInstanceOf(TermsRequiredError);

    stub(answer(400, { error: "telo_version_unavailable", message: "m", app: "api", version: "9.9.9", reason: "no such release" }));
    const refusal = await connection.createSession(request, {}).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(TeloVersionRefusedError);
    expect(refusal).toMatchObject({ app: "api", version: "9.9.9", reason: "no such release" });

    stub(answer(429, { error: "too_many_sessions", message: "the runner holds 8 running sessions" }));
    await expect(connection.createSession(request, {})).rejects.toThrow("the runner holds 8 running sessions");
  });
});

describe("a session's routes", () => {
  it("carry the session's credentials on every request, and a 404 is the session gone", async () => {
    const fetchMock = stub(answer(202, { apps: ["api"] }), answer(202, { runId: "r1" }), answer(404, { error: "not_found", message: "no session" }));
    const session = (await adapter.connect({ baseUrl: BASE })).session("s1", resumeSecretCredentials("sek"));

    await session.setApps([{ name: "api", entryRelativePath: "api/telo.yaml" }]);
    expect(await session.runApp("api", { env: { A: "1" }, io: "streams" })).toBe("r1");
    await expect(session.suspend()).rejects.toBeInstanceOf(SessionGoneError);

    expect([0, 1, 2].map((i) => [call(fetchMock, i).method, call(fetchMock, i).url, call(fetchMock, i).headers.authorization])).toEqual([
      ["PUT", `${BASE}/v1/sessions/s1/apps`, "Bearer sek"],
      ["POST", `${BASE}/v1/sessions/s1/apps/api/run`, "Bearer sek"],
      ["POST", `${BASE}/v1/sessions/s1/suspend`, "Bearer sek"],
    ]);
    expect(call(fetchMock, 1).body).toEqual({ env: { A: "1" }, io: "streams" });
  });

  it("open the byte channel with a ticket the credentials minted, never the secret", async () => {
    const fetchMock = stub(answer(201, { ticket: "tk-1", expiresAt: "2026-10-24T00:00:30Z" }));
    const opened: string[] = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      binaryType = "";
      constructor(url: string) {
        super();
        opened.push(url);
      }
      close() {}
      send() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const session = (await adapter.connect({ baseUrl: BASE })).session("s1", resumeSecretCredentials("sek"));

    session.io("api", 7).open({ onData() {}, onClose() {} });
    await vi.waitFor(() => expect(opened).toHaveLength(1));

    expect(call(fetchMock, 0)).toMatchObject({ method: "POST", url: `${BASE}/v1/sessions/s1/io-tickets`, body: { app: "api" } });
    expect(opened[0]).toBe("ws://runner.test/v1/sessions/s1/io?ticket=tk-1&lastSeq=7");
    expect(opened[0]).not.toContain("sek");
  });
});
