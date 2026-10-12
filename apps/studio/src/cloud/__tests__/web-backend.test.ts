import { afterEach, describe, expect, it, vi } from "vitest";
import { WebCloudBackend } from "../web-backend";

const SESSION = {
  user: { id: "usr_1", name: "Ada", email: "ada@example.com" },
  org: { id: "org_1" },
  permissions: ["cloud:access"],
  csrfToken: "csrf-1",
  consoleUrl: "https://console.telo.cloud",
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
        consoleUrl: SESSION.consoleUrl,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("names no console when the session names none", async () => {
    const { consoleUrl: _, ...older } = SESSION;
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, JSON.stringify(older), "application/json")));
    const state = await new WebCloudBackend().read();
    expect(state.status === "signedIn" && state.identity.consoleUrl).toBeNull();
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

  it("signs in back to the current address, into a named organization when given one", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/", search: "?org=org_1&project=prj_1", hash: "", assign });
    const backend = new WebCloudBackend();
    void backend.signIn();
    void backend.signIn("org_1");
    expect(assign.mock.calls).toEqual([
      ["/api/session/login?returnTo=%2F%3Forg%3Dorg_1%26project%3Dprj_1"],
      ["/api/session/login?returnTo=%2F%3Forg%3Dorg_1%26project%3Dprj_1&orgId=org_1"],
    ]);
  });

  it("sends the CSRF token on unsafe methods only", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      answer(200, JSON.stringify(SESSION), "application/json"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new WebCloudBackend();
    await backend.read();
    await backend.request({ method: "GET", path: "/v1/projects" });
    await backend.request({ method: "POST", path: "/v1/projects/prj_1/publications", body: "{}" });
    const headersOf = (call: number) => fetchMock.mock.calls[call]![1].headers as Record<string, string>;
    expect(headersOf(1)["x-csrf-token"]).toBeUndefined();
    expect(headersOf(2)["x-csrf-token"]).toBe("csrf-1");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/v1/projects/prj_1/publications");
  });
});
