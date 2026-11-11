import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { exchange, FakeWebview, fixture, ofType, opened, portOf, scratch, telo, until, useHarness, type Hop } from "./__fixtures__/desktop-host/harness.js";

/**
 * External sign-in through the desktop host's armed return, driven through the
 * built CLI with the fake helper as the helper, a raw HTTP client as the system
 * browser (its own connections, no cookie) and a fake webview — one keep-alive
 * pool and cookie jar for every window — as the window. POSIX only.
 */

const SIGNIN = fixture("signin");
const SIGNIN_EXACT = fixture("signin-exact");
const IDP = "https://id.example.com/authorize?client_id=notes";
const FORM = "application/x-www-form-urlencoded";

useHarness();

interface Hosted {
  port: number;
  /** The app's origin. */
  origin: string;
  hostOrigin: string;
  log: string;
  /** The system browser's request: the host only, no cookie. */
  browser(request: string, extra?: string[]): Promise<string>;
  /** The window, holding the cookie and an idle pooled connection to the app. */
  webview: FakeWebview;
  /** The window's page as it was first served: its connection is the pooled one. */
  page: Hop;
  /** A window sends a navigation to the system browser; resolves once the host has armed the return. */
  navigateExternally(window?: string): Promise<void>;
  inject(type: string, payload: unknown): void;
  navigations(): Array<{ window: string; url: string }>;
  run: ReturnType<typeof telo>;
}

async function host(app = SIGNIN): Promise<Hosted> {
  const session = scratch();
  const inject = path.join(session.dir, "inject.jsonl");
  const opens = path.join(session.dir, "browser.txt");
  const browser = path.join(session.dir, "browser.sh");
  fs.writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opens}'\n`, { mode: 0o755 });
  const run = telo(app, { ...session.env, BROWSER: browser, FAKE_HELPER_INJECT: inject });
  const main = await opened(session.log, "mainWindow");
  const init = ofType(session.log, "Helper.Init")[0].payload;
  const port = portOf(init.origin);
  const hostHeader = `Host: 127.0.0.1:${port}`;
  const send = (request: string, headers: string[]) => {
    const [line, ...rest] = request.split("\r\n");
    return exchange(port, [line, ...headers, "Connection: close", ...rest].join("\r\n"));
  };
  const webview = new FakeWebview();
  const landed = (await webview.load(main.payload.url as string)).at(-1)!;
  // The app's own server answers once it has claimed the socket.
  const page = await until("the app", async () => {
    const hop = landed.status === 200 ? landed : (await webview.load(landed.url)).at(-1)!;
    return hop.status === 200 && hop;
  });
  const hosted: Hosted = {
    port,
    origin: init.origin,
    hostOrigin: init.hostOrigin,
    log: session.log,
    run,
    webview,
    page,
    browser: (request, extra = []) => send(request, [hostHeader, ...extra]),
    inject: (type, payload) => fs.appendFileSync(inject, `${JSON.stringify({ type, payload })}\n`),
    async navigateExternally(window = "mainWindow") {
      const before = fs.existsSync(opens) ? fs.readFileSync(opens, "utf8").split("\n").length : 1;
      hosted.inject("Navigation.External", { window, url: IDP });
      await until("the system browser being asked", () => fs.existsSync(opens) && fs.readFileSync(opens, "utf8").split("\n").length > before);
    },
    navigations: () => ofType(session.log, "Window.Navigate").map((r) => r.payload as { window: string; url: string }),
  };
  return hosted;
}

const body = (answer: string) => answer.slice(answer.indexOf("\r\n\r\n") + 4);
const status = (answer: string) => answer.slice(0, answer.indexOf("\r\n"));
const FORBIDDEN = "HTTP/1.1 403 Forbidden";
const post = (target: string, text: string, type = FORM) =>
  `POST ${target} HTTP/1.1\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
const stop = async (h: Hosted) => {
  h.run.child.kill("SIGTERM");
  expect(await h.run.exited).toBe(0);
};

describe.skipIf(process.platform === "win32")("external sign-in under the desktop host", () => {
  it("replays a GET return in the window that armed it, once, and refuses everything else with 403", async () => {
    const h = await host();
    expect(status(await h.browser("GET /auth/callback?code=c1&state=s1 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);

    await h.navigateExternally();
    // None of these uses the return up.
    expect(status(await h.browser("GET /oauth2/return?code=c1 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);
    expect(status(await h.browser("GET //auth/callback?code=c1 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);
    expect(status(await h.browser("GET /auth%2Fcallback?code=c1 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);
    expect(status(await h.browser("PUT /auth/callback HTTP/1.1\r\nContent-Length: 0\r\n\r\n"))).toBe(FORBIDDEN);
    expect(status(await exchange(h.port, "GET /auth/callback?code=c1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))).toBe(FORBIDDEN);
    expect(h.navigations()).toEqual([]);

    const answer = await h.browser("GET /auth/callback?code=c1&state=s1 HTTP/1.1\r\n\r\n");
    expect(status(answer)).toBe("HTTP/1.1 200 OK");
    expect(answer).toContain("Cache-Control: no-store\r\n");
    expect(answer).toMatch(/Content-Type: text\/html/);
    expect(body(answer)).toBe("<p>Return to Notes to finish signing in.</p>");

    const navigate = await until("the replay", () => h.navigations()[0]);
    expect(navigate).toEqual({ window: "mainWindow", url: `${h.origin}/auth/callback?code=c1&state=s1` });
    expect(ofType(h.log, "Window.Focus").map((r) => r.payload.window)).toEqual(["mainWindow"]);

    // The window follows it, with its cookie, on its pooled connection, and the app answers.
    const [replayed, after] = await h.webview.load(navigate.url);
    expect(replayed).toMatchObject({ status: 302, reused: true, localPort: h.page.localPort });
    expect(replayed.headers.location).toBe("/");
    expect(replayed.headers["set-cookie"]).toContainEqual(expect.stringMatching(/^notes-session=Jk29fQ7xLm/));
    expect(JSON.parse(replayed.body)).toMatchObject({ method: "GET", query: { code: "c1", state: "s1" } });
    expect(after).toMatchObject({ status: 200, url: `${h.origin}/` });

    // The same return a second time, while nothing is armed.
    expect(status(await h.browser("GET /auth/callback?code=c1&state=s1 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);
    await stop(h);
  }, 120_000);

  it("replays a form POST return as a single-use page of the host origin that submits the stored fields to the app on the window's pooled connection", async () => {
    const h = await host();
    await h.navigateExternally();
    const fields = "code=c%3C1&state=s&code=%22two%22&x=%26%27";
    // Refused, and the return stays armed: another type, no length, too large.
    expect(status(await h.browser(post("/auth/callback", '{"code":1}', "application/json")))).toBe(FORBIDDEN);
    expect(status(await h.browser(`POST /auth/callback HTTP/1.1\r\nContent-Type: ${FORM}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`))).toBe(FORBIDDEN);
    expect(status(await h.browser(`POST /auth/callback HTTP/1.1\r\nContent-Type: ${FORM}\r\nContent-Length: 65537\r\n\r\n`))).toBe(FORBIDDEN);
    expect(h.navigations()).toEqual([]);

    // From the identity provider's origin: the Origin rule does not apply to the armed return.
    const answer = await h.browser(post("/auth/callback", fields), ["Origin: https://id.example.com"]);
    expect(status(answer)).toBe("HTTP/1.1 200 OK");
    expect(body(answer)).toBe("<p>Return to Notes to finish signing in.</p>");
    const { url } = await until("the replay", () => h.navigations()[0]);
    const code = new URL(url).searchParams.get("code")!;
    expect(url).toBe(`${h.hostOrigin}/return?code=${code}`);
    expect(code).toMatch(/^[\w-]{24}$/);
    expect(ofType(h.log, "Window.Focus").map((r) => r.payload.window)).toEqual(["mainWindow"]);
    // Used up: a second POST is refused.
    expect(status(await h.browser(post("/auth/callback", fields)))).toBe(FORBIDDEN);
    // The page is the window's alone: without the cookie the host origin refuses it, and keeps the code.
    const hostPort = portOf(h.hostOrigin);
    expect(status(await exchange(hostPort, `GET /return?code=${code} HTTP/1.1\r\nHost: 127.0.0.1:${hostPort}\r\nConnection: close\r\n\r\n`))).toBe(FORBIDDEN);

    const [page] = await h.webview.load(url);
    expect(page).toMatchObject({ status: 200, url });
    expect(page.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" });
    expect(page.body).toBe(
      `<form method="post" action="${h.origin}/auth/callback">` +
        '<input type="hidden" name="code" value="c&lt;1">' +
        '<input type="hidden" name="state" value="s">' +
        '<input type="hidden" name="code" value="&quot;two&quot;">' +
        '<input type="hidden" name="x" value="&amp;&#39;">' +
        "</form><script>document.forms[0].submit()</script>",
    );

    // The page's submission reaches the app with the cookie and the host origin as Origin, on the pooled connection.
    const [submitted, after] = await h.webview.submitForm(url, page.body);
    expect(submitted).toMatchObject({ method: "POST", status: 302, url: `${h.origin}/auth/callback`, reused: true, localPort: h.page.localPort });
    const echoed = JSON.parse(submitted.body);
    expect(echoed).toMatchObject({ method: "POST", origin: h.hostOrigin, body: 'code=c%3C1&state=s&code=%22two%22&x=%26%27' });
    expect(echoed.cookie).toContain("telo-window=");
    expect(submitted.headers["set-cookie"]).toContainEqual(expect.stringMatching(/^notes-session=Jk29fQ7xLm/));
    expect(after).toMatchObject({ status: 200, url: `${h.origin}/` });

    // The code is consumed: the next use is refused, and leaks no field.
    const [again] = await h.webview.load(url);
    expect(again.status).toBe(403);
    expect(again.body).toBe("");
    // No code ever reached the app's origin.
    expect(h.webview.on(h.origin).filter((hop) => hop.url.includes(code))).toEqual([]);
    await stop(h);
  }, 120_000);

  it("replays in the window that armed it last, and a closed window's return is cleared", async () => {
    const h = await host();
    h.inject("Window.OpenRequested", { fromWindow: "mainWindow", url: `${h.origin}/second` });
    await opened(h.log, "telo.opened.1");

    await h.navigateExternally("telo.opened.1");
    await h.navigateExternally("mainWindow");
    expect(status(await h.browser("GET /auth/callback?code=1 HTTP/1.1\r\n\r\n"))).toBe("HTTP/1.1 200 OK");
    expect((await until("the replay", () => h.navigations()[0])).window).toBe("mainWindow");

    await h.navigateExternally("telo.opened.1");
    h.inject("Window.Closed", { window: "telo.opened.1" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(status(await h.browser("GET /auth/callback?code=2 HTTP/1.1\r\n\r\n"))).toBe(FORBIDDEN);
    expect(h.navigations()).toHaveLength(1);
    await stop(h);
  }, 120_000);

  it("works on the origin an application's declared port default fixes", async () => {
    const h = await host(SIGNIN_EXACT);
    expect(h.origin).toBe("http://127.0.0.1:47831");
    await h.navigateExternally();
    expect(status(await h.browser("GET /auth/callback?code=1 HTTP/1.1\r\n\r\n"))).toBe("HTTP/1.1 200 OK");
    expect((await until("the replay", () => h.navigations()[0])).url).toBe("http://127.0.0.1:47831/auth/callback?code=1");
    await stop(h);
  }, 120_000);
});
