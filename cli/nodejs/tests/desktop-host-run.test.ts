import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  debugLogs,
  FakeWebview,
  fixture,
  freePort,
  ofType,
  opened,
  portOf,
  requests,
  scratch,
  telo,
  until,
  useHarness,
  type Request,
} from "./__fixtures__/desktop-host/harness.js";

/**
 * `telo run` as the desktop host of a wrapper application, driven through the
 * built CLI with the fake helper standing in for `telo-desktop-host` and a fake
 * webview — one keep-alive connection pool and cookie jar for every window — for
 * the windows. POSIX only: the fake helper runs through its shebang.
 */

const APP = fixture("app");
const CLOSING = fixture("closing");
/** The two origins `Helper.Init` named. */
const originsOf = (init: Request) => ({ app: init.payload.origin as string, host: init.payload.hostOrigin as string });

/** Loads a window's first URL, then its page again until the app's server has claimed the socket. */
async function loadWindow(webview: FakeWebview, open: Request, appOrigin: string) {
  const chain = await webview.load(open.payload.url as string);
  const landed = chain.at(-1)!;
  if (landed.status === 200) return chain;
  return until("the app's page", async () => {
    const again = (await webview.load(landed.url)).at(-1)!;
    return again.status === 200 && new URL(again.url).origin === appOrigin && [...chain, again];
  });
}

// Chosen a moment after the icon opens, as a person would: the tray subscribes once Tray.Open is answered.
const QUIT_FROM_TRAY = { after: "Tray.Open", type: "Tray.ItemChosen", payload: { tray: "tray", item: 0 }, delayMs: 300 };

useHarness();

describe.skipIf(process.platform === "win32")("telo run as the desktop host", () => {
  it("admits a window on the host origin, then serves it from the app's own server on the host's socket", async () => {
    const session = scratch();
    const started = path.join(session.dir, "started.json");
    const run = telo(APP, { ...session.env, FAKE_HELPER_STARTED: started }, ["--debug"]);
    const main = await opened(session.log, "mainWindow");
    const origins = originsOf(ofType(session.log, "Helper.Init")[0]);
    const port = portOf(origins.app);
    expect(portOf(origins.host)).not.toBe(port);
    expect(main.payload.url).toMatch(new RegExp(`^${origins.host}/admit\\?code=[\\w-]{24}$`));

    const webview = new FakeWebview();
    const [admit, ...rest] = await loadWindow(webview, main, origins.app);
    expect(admit).toMatchObject({ status: 303, url: main.payload.url });
    expect(admit.headers).toMatchObject({ location: `${origins.app}/`, "referrer-policy": "no-referrer", "cache-control": "no-store" });
    const secret = /^telo-window=([^;]+); HttpOnly; SameSite=Strict; Path=\/$/.exec(admit.headers["set-cookie"]![0])![1];
    // Admitted before the server has claimed the socket, a request is answered 503 until it has.
    expect(rest.at(-1)).toMatchObject({ status: 200, url: `${origins.app}/`, body: "<h1>Hello</h1>" });

    // The ports the run reports: the host's socket on loopback.
    const debugLog = path.join(APP, ".telo.debug.jsonl");
    // The run keeps appending to its log, so it is removed once the run has ended.
    debugLogs.push(debugLog);
    const resolved = fs
      .readFileSync(debugLog, "utf8")
      .split("\n")
      .filter((line) => line.includes('"Kernel.PortsResolved"'))
      .map((line) => JSON.parse(line) as { payload: { ports: unknown[] } });
    expect(resolved.at(-1)?.payload.ports).toEqual([
      { name: "http", port, protocol: "tcp", address: "127.0.0.1", suppliedBy: "host" },
    ]);

    // Neither the admission secret nor a need's value reaches the helper, and the host origin is recorded nowhere.
    expect(fs.readFileSync(path.join(session.dataRoot, "run.telo.tests.desktophost", "desktop-host", "port"), "utf8")).toBe(`${port}\n`);
    const { argv, env } = JSON.parse(fs.readFileSync(started, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(argv).toEqual([]);
    expect(Object.values(env).some((value) => value.includes(secret))).toBe(false);
    expect(Object.keys(env).filter((name) => name.startsWith("TELO_NEED_"))).toEqual([]);

    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(ofType(session.log, "Helper.Quit")).toHaveLength(1);
    expect(fs.readdirSync(path.join(session.dataRoot, "run.telo.tests.desktophost", "desktop-host")).sort()).toEqual([
      "port",
      "webview",
    ]);
  }, 120_000);

  it("stops gracefully with 0 on the module's Host.Quit", async () => {
    const session = scratch();
    const run = telo(APP, { ...session.env, FAKE_HELPER_EMIT: JSON.stringify([QUIT_FROM_TRAY]) });
    expect(await run.exited).toBe(0);
    expect(ofType(session.log, "Helper.Quit")).toHaveLength(1);
  }, 120_000);

  it("stops gracefully with 0 when the OS quits the helper", async () => {
    const session = scratch();
    const quit = { after: "Tray.Open", type: "Helper.QuitRequested", payload: {} };
    const run = telo(APP, { ...session.env, FAKE_HELPER_EMIT: JSON.stringify([quit]) });
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("stops with 1 and an error when the helper exits unasked", async () => {
    const session = scratch();
    const run = telo(APP, { ...session.env, FAKE_HELPER_EXIT: JSON.stringify({ after: "Tray.Open", code: 3 }) });
    expect(await run.exited).toBe(1);
    expect(run.stdout() + run.stderr()).toContain("the desktop helper exited with code 3 without being asked to quit");
  }, 120_000);

  it("a second start shows again what the start showed — not a hidden window a tray reaches — and exits 0", async () => {
    const session = scratch();
    const first = telo(APP, session.env);
    await until("the tray", () => ofType(session.log, "Tray.Open").length > 0);

    const second = telo(APP, session.env);
    expect(await second.exited).toBe(0);
    expect(second.stdout()).toBe(`Fixture is already running (process ${first.child.pid}, ${path.join(APP, "telo.yaml")}); its windows are shown\n`);
    expect(
      requests(session.log)
        .filter((r) => r.type === "Window.Show" || r.type === "Window.Focus")
        .map((r) => `${r.type} ${r.payload.window}`),
    ).toEqual(["Window.Show mainWindow", "Window.Focus mainWindow"]);
    // The second start started no helper of its own.
    expect(ofType(session.log, "Helper.Init")).toHaveLength(1);
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);
  }, 120_000);

  it("with no tray, shows every hidden window at start and on a second start", async () => {
    const session = scratch();
    const env = { ...session.env, FAKE_HELPER_TRAY: "false" };
    const first = telo(APP, env);
    const settings = await opened(session.log, "settingsWindow");
    expect(settings.payload.visible).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ofType(session.log, "Tray.Open")).toEqual([]);

    expect(await telo(APP, env).exited).toBe(0);
    expect(ofType(session.log, "Window.Show").map((r) => r.payload.window)).toEqual(["mainWindow", "settingsWindow"]);
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);
  }, 120_000);

  it("stops with 0 when the user closes the last window and no tray icon is open", async () => {
    const session = scratch();
    const closed = { after: "Window.Open", type: "Window.Closed", payload: { window: "onlyWindow" } };
    const run = telo(CLOSING, { ...session.env, FAKE_HELPER_EMIT: JSON.stringify([closed]) });
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("keeps the origin's port across launches, and records a new one with DESKTOP_ORIGIN_CHANGED when it is taken", async () => {
    const session = scratch();
    const env = { ...session.env, FAKE_HELPER_EMIT: JSON.stringify([QUIT_FROM_TRAY]) };
    const portFile = path.join(session.dataRoot, "run.telo.tests.desktophost", "desktop-host", "port");
    const origins = () => ofType(session.log, "Helper.Init").map((r) => portOf(r.payload.origin));

    expect(await telo(APP, env).exited).toBe(0);
    expect(await telo(APP, env).exited).toBe(0);
    const [first, again] = origins();
    expect(again).toBe(first);
    expect(fs.readFileSync(portFile, "utf8")).toBe(`${first}\n`);

    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(first, "127.0.0.1", resolve));
    try {
      const moved = telo(APP, env);
      expect(await moved.exited).toBe(0);
      const now = origins()[2];
      expect(now).not.toBe(first);
      expect(fs.readFileSync(portFile, "utf8")).toBe(`${now}\n`);
      expect(moved.stdout() + moved.stderr()).toContain("DESKTOP_ORIGIN_CHANGED");
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  }, 180_000);

  it("opens a same-origin window.open in another window, and any other origin in the system browser if it is http(s)", async () => {
    const session = scratch();
    // The recorded port is the one bound, so the navigations can name the origin up front.
    const port = await freePort();
    const hostDirectory = path.join(session.dataRoot, "run.telo.tests.desktophost", "desktop-host");
    fs.mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(hostDirectory, "port"), `${port}\n`);
    const opens = path.join(session.dir, "browser.txt");
    const browser = path.join(session.dir, "browser.sh");
    fs.writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opens}'\n`, { mode: 0o755 });
    const navigate = (type: string, url: string) => ({
      after: "Tray.Open",
      type,
      payload: type === "Window.OpenRequested" ? { fromWindow: "mainWindow", url } : { window: "mainWindow", url },
    });
    const emits = [
      navigate("Window.OpenRequested", `http://127.0.0.1:${port}/report?id=7`),
      navigate("Window.OpenRequested", "http://example.com/elsewhere"),
      navigate("Navigation.External", "file:///etc/passwd"),
      navigate("Navigation.External", "https://id.example/authorize?x=1"),
    ];
    const run = telo(APP, { ...session.env, BROWSER: browser, FAKE_HELPER_EMIT: JSON.stringify(emits) });
    const another = await opened(session.log, "telo.opened.1");
    expect(another.payload).toMatchObject({ visible: true, onClose: "close" });
    // Its own admission, landing on the address it asked for.
    const [admit] = await new FakeWebview().load(another.payload.url as string);
    expect(admit.headers.location).toBe(`http://127.0.0.1:${port}/report?id=7`);

    const browsed = () => (fs.existsSync(opens) ? fs.readFileSync(opens, "utf8").trim().split("\n").sort() : []);
    await until("both browser opens", () => browsed().length === 2);
    expect(browsed()).toEqual(["http://example.com/elsewhere", "https://id.example/authorize?x=1"]);
    expect(run.stdout() + run.stderr()).toContain("only an http or https address opens in the system browser");
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("admits a second window on the host origin while the first window's connection to the app idles in the pool", async () => {
    const session = scratch();
    const run = telo(APP, session.env);
    const main = await opened(session.log, "mainWindow");
    const settings = await opened(session.log, "settingsWindow");
    const origins = originsOf(ofType(session.log, "Helper.Init")[0]);
    const webview = new FakeWebview();

    const first = (await loadWindow(webview, main, origins.app)).at(-1)!;
    const second = await webview.load(settings.payload.url as string);
    expect(second.map((hop) => [hop.status, hop.url])).toEqual([
      [303, settings.payload.url],
      [404, `${origins.app}/settings`],
    ]);
    // The second window's page went on the first one's idle connection, which the kernel owns.
    expect(second[1]).toMatchObject({ reused: true, localPort: first.localPort });
    // No exchange of the host's ever reached the app's origin, and no code was ever in an app-origin URL.
    expect(webview.on(origins.app).filter((hop) => /admit|code=/.test(hop.url))).toEqual([]);
    expect(webview.hops.filter((hop) => hop.url.includes("/admit")).every((hop) => hop.url.startsWith(`${origins.host}/`))).toBe(true);
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("opens nothing for a window.open to the host origin", async () => {
    const session = scratch();
    const inject = path.join(session.dir, "inject.jsonl");
    const opens = path.join(session.dir, "browser.txt");
    const browser = path.join(session.dir, "browser.sh");
    fs.writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opens}'\n`, { mode: 0o755 });
    const run = telo(APP, { ...session.env, BROWSER: browser, FAKE_HELPER_INJECT: inject });
    await until("the tray", () => ofType(session.log, "Tray.Open").length > 0);
    const { host } = originsOf(ofType(session.log, "Helper.Init")[0]);
    fs.appendFileSync(inject, `${JSON.stringify({ type: "Window.OpenRequested", payload: { fromWindow: "mainWindow", url: `${host}/startup` } })}\n`);
    await until("the refusal", () => (run.stdout() + run.stderr()).includes("asked to open a page of the host's own"));
    expect(ofType(session.log, "Window.Open").map((r) => r.payload.window)).not.toContain("telo.opened.1");
    expect(fs.existsSync(opens)).toBe(false);
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("under an environment-supplied host, starts no helper, takes no lock and binds nothing", async () => {
    const session = scratch();
    const run = telo(APP, {
      ...session.env,
      DESKTOP_FIXTURE_PORT: String(await freePort()),
      TELO_NEED_DESKTOP_HOST__ENDPOINT: `unix://${path.join(session.dir, "nobody.sock")}`,
      TELO_NEED_DESKTOP_HOST__TOKEN: "env-token",
    });
    expect(await run.exited).not.toBe(0);
    expect(run.stdout() + run.stderr()).toContain("ERR_DESKTOP_HOST_UNREACHABLE");
    expect(fs.existsSync(session.log)).toBe(false);
    expect(fs.existsSync(path.join(session.dataRoot, "run.telo.tests.desktophost"))).toBe(false);
  }, 120_000);
});
