import { afterEach, describe, expect, it, vi } from "vitest";
import { WebCloudBackend } from "../web-backend";

const SESSION = {
  user: { id: "usr_1", name: "Ada", email: "ada@example.com" },
  org: { id: "org_1" },
  permissions: ["cloud:access"],
  csrfToken: "csrf-1",
  expiresAt: "2026-11-01T00:00:00Z",
};

function answer(status: number, body: string, type: string): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

afterEach(() => vi.unstubAllGlobals());

describe("WebCloudBackend", () => {
  it("is signed in on a session of the right shape, and keeps no token but the CSRF one", async () => {
    const fetchMock = vi.fn(async () => answer(200, JSON.stringify(SESSION), "application/json"));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new WebCloudBackend();
    const state = await backend.read();
    expect(state).toEqual({
      status: "signedIn",
      identity: {
        user: SESSION.user,
        org: SESSION.org,
        permissions: SESSION.permissions,
        expiresAt: SESSION.expiresAt,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("is anonymous on 401 session_required", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(401, '{"code":"session_required"}', "application/problem+json")));
    expect(await new WebCloudBackend().read()).toEqual({ status: "anonymous" });
  });

  it("finds no Cloud on an origin that answers with the page itself, a 404, or nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, "<!doctype html>", "text/html")));
    expect(await new WebCloudBackend().read()).toEqual({ status: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => answer(404, "not found", "text/html")));
    expect(await new WebCloudBackend().read()).toEqual({ status: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("failed to fetch"))));
    expect(await new WebCloudBackend().read()).toEqual({ status: "unavailable" });
    // JSON, but not a session.
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, '{"ok":true}', "application/json")));
    expect(await new WebCloudBackend().read()).toEqual({ status: "unavailable" });
  });

  it("sends the CSRF token on unsafe methods only", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      answer(200, JSON.stringify(SESSION), "application/json"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new WebCloudBackend();
    await backend.read();
    await backend.request({ method: "GET", path: "/v1/workspaces" });
    await backend.request({ method: "POST", path: "/v1/workspaces/wks_1/publications", body: "{}" });
    const headersOf = (call: number) => fetchMock.mock.calls[call]![1].headers as Record<string, string>;
    expect(headersOf(1)["x-csrf-token"]).toBeUndefined();
    expect(headersOf(2)["x-csrf-token"]).toBe("csrf-1");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/v1/workspaces/wks_1/publications");
  });
});
