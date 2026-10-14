import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNTS_ORIGIN, resolveAccountsOrigin } from "../accounts-origin";

function answer(status: number, body: string, type: string): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

function fetchAnswering(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("resolveAccountsOrigin", () => {
  it("reads the web build's accounts origin from /config.json", async () => {
    const fetchMock = fetchAnswering(
      answer(200, '{"accountsUrl":"https://accounts.example.com"}', "application/json"),
    );
    const origin = await resolveAccountsOrigin({
      desktop: false,
      fetch: fetchMock,
      buildTimeAccountsUrl: "https://accounts.build.example",
    });
    expect(origin).toBe("https://accounts.example.com");
    expect(fetchMock).toHaveBeenCalledWith("/config.json", expect.anything());
  });

  it("falls back to the build setting where /config.json is the dev server's page", async () => {
    const origin = await resolveAccountsOrigin({
      desktop: false,
      fetch: fetchAnswering(answer(200, "<!doctype html>", "text/html")),
      buildTimeAccountsUrl: "https://accounts.build.example",
    });
    expect(origin).toBe("https://accounts.build.example");
  });

  it("falls back to the public accounts when /config.json is missing and the build names none", async () => {
    const origin = await resolveAccountsOrigin({
      desktop: false,
      fetch: fetchAnswering(answer(404, "", "text/html")),
      buildTimeAccountsUrl: undefined,
    });
    expect(origin).toBe(DEFAULT_ACCOUNTS_ORIGIN);
  });

  it.each([
    ['{"accountsUrl":"http://accounts.example.com"}', "not https"],
    ['{"accountsUrl":"https://accounts.example.com/v1"}', "a path"],
    ['{"accountsUrl":"https://u:p@accounts.example.com"}', "credentials"],
    ['{"accountsUrl":42}', "not a string"],
    ["[]", "not an object"],
    ["{not json", "not JSON"],
  ])("ignores a /config.json naming %s (%s)", async (body) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const origin = await resolveAccountsOrigin({
      desktop: false,
      fetch: fetchAnswering(answer(200, body, "application/json")),
      buildTimeAccountsUrl: undefined,
    });
    expect(origin).toBe(DEFAULT_ACCOUNTS_ORIGIN);
  });

  it("uses the build setting on the desktop and reads no /config.json", async () => {
    const fetchMock = fetchAnswering(new Error("unreachable"));
    const origin = await resolveAccountsOrigin({
      desktop: true,
      fetch: fetchMock,
      buildTimeAccountsUrl: "https://accounts.build.example/",
    });
    expect(origin).toBe("https://accounts.build.example");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trust a build setting that is not an https origin", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const origin = await resolveAccountsOrigin({
      desktop: true,
      fetch: fetchAnswering(new Error("unreachable")),
      buildTimeAccountsUrl: "http://accounts.build.example",
    });
    expect(origin).toBe(DEFAULT_ACCOUNTS_ORIGIN);
  });
});
