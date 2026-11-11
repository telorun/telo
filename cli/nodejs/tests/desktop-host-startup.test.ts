import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  FakeWebview,
  fixture,
  ofType,
  opened,
  requests,
  scratch,
  telo,
  until,
  useHarness,
  type Scratch,
} from "./__fixtures__/desktop-host/harness.js";

/**
 * The desktop host's own window — the startup view, the form that asks the
 * root's missing inputs, the boot refusal — through the built CLI with the fake
 * helper, and a fake webview (one keep-alive pool and cookie jar) for the windows.
 * POSIX only.
 */

useHarness();

const ASKING = fixture("asking");
const FAILING = fixture("failing");
const HIDING = fixture("hiding");
const TRAY_ONLY = fixture("trayonly");
const APP = fixture("app");
const STARTING = fixture("starting");
const STARTUP = "telo.startup";

/** What a webview does for the startup window: its admission on the host origin, then the page. */
async function admitted(session: Scratch) {
  const open = await opened(session.log, STARTUP);
  const init = ofType(session.log, "Helper.Init")[0].payload;
  const origins = { app: init.origin as string, host: init.hostOrigin as string };
  const webview = new FakeWebview();
  const page = `${origins.host}/startup`;
  return {
    open,
    origins,
    webview,
    admission: await webview.load(open.payload.url as string),
    /** The startup page now: the last hop of reloading it. */
    read: async () => (await webview.load(page)).at(-1)!,
    /** The form's submission from the page, and the redirect it answers. */
    post: (body: string) => webview.submit(page, "/startup/answers", body),
  };
}

const view = (body: string) => /data-view="([a-z-]+)"/.exec(body)?.[1];
const tokenOf = (body: string) => /name="_telo\.token" value="([^"]+)"/.exec(body)![1];
const form = (token: string, answers: Record<string, string>) =>
  new URLSearchParams({ "_telo.token": token, ...answers }).toString();
const inject = (file: string, type: string, payload: unknown) =>
  fs.appendFileSync(file, `${JSON.stringify({ type, payload })}\n`);
const index = (session: Scratch, type: string, window: string) =>
  requests(session.log).findIndex((r) => r.type === type && r.payload.window === window);

describe.skipIf(process.platform === "win32")("the desktop host's startup window", () => {
  it("opens before the kernel loads, admitted on the host origin, and asks the missing inputs in a form", async () => {
    const session = scratch();
    const run = telo(ASKING, session.env, [], { noInput: false });
    const startup = await admitted(session);

    expect(startup.open.payload).toMatchObject({ window: STARTUP, title: "Asking", visible: true, onClose: "close" });
    expect(startup.admission.map((hop) => [hop.status, hop.url])).toEqual([
      [303, startup.open.payload.url],
      [200, `${startup.origins.host}/startup`],
    ]);
    expect(requests(session.log).findIndex((r) => r.type === "Window.Open")).toBe(
      requests(session.log).findIndex((r) => r.type === "Window.Open" && r.payload.window === STARTUP),
    );

    const page = await until("the form", async () => {
      const hop = await startup.read();
      return view(hop.body) === "form" && hop;
    });
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers.connection).toBe("close");
    const html = page.body;
    // Each missing input by its declaration: type, enum, secret.
    expect(html).toContain('<label for="a0">DESKTOP_ASKING_GREETING</label><input id="a0" name="a0" type="text"');
    expect(html).toContain("The greeting");
    expect(html).toContain('name="a1" type="text" inputmode="decimal"');
    expect(html).toContain('<select id="a2" name="a2"><option value="fast">fast</option><option value="slow">slow</option></select>');
    expect(html).toContain('<label for="a3">DESKTOP_ASKING_TOKEN</label><input id="a3" name="a3" type="password" autocomplete="off">');

    run.child.kill("SIGTERM");
    await run.exited;
  }, 120_000);

  it("takes the answers once, shows the kernel's refusal of a bad one with the values kept, and starts on a good one", async () => {
    const session = scratch();
    const run = telo(ASKING, session.env, [], { noInput: false });
    const startup = await admitted(session);
    const formNow = () =>
      until("the form", async () => {
        const hop = await startup.read();
        return view(hop.body) === "form" && hop.body;
      });
    const first = tokenOf(await formNow());

    // A token that is not the form's changes nothing; the window goes back to the page.
    const forged = await startup.post(form("forged", { a0: "x", a1: "1", a2: "fast", a3: "t" }));
    expect(forged.map((hop) => [hop.status, hop.url])).toEqual([
      [303, `${startup.origins.host}/startup/answers`],
      [200, `${startup.origins.host}/startup`],
    ]);
    expect(tokenOf(forged[1].body)).toBe(first);

    // count: 0 is under the declared minimum; the kernel refuses it and the form comes back.
    const secret = "s3cr3t-value";
    expect((await startup.post(form(first, { a0: "hello", a1: "0", a2: "fast", a3: secret })))[0].status).toBe(303);
    const again = await until("the refused form", async () => {
      const hop = await startup.read();
      return hop.body.includes('class="error"') && hop.body;
    });
    expect(view(again)).toBe("form");
    expect(again).toContain('class="error"');
    // Only the refused input is asked again, its given value kept; what was accepted stays answered.
    expect(again).toContain("DESKTOP_ASKING_COUNT");
    expect(again).not.toContain("DESKTOP_ASKING_GREETING");
    expect(again).toContain('value="0"');
    expect(again).not.toContain(secret);
    const second = tokenOf(again);
    expect(second).not.toBe(first);

    // The first form's token is spent: posting it again does not answer the second form.
    await startup.post(form(first, { a0: "7" }));
    expect(tokenOf((await startup.read()).body)).toBe(second);

    await startup.post(form(second, { a0: "3" }));
    await opened(session.log, "onlyWindow").catch((e) => {
      throw new Error(`${e.message}\n${run.stdout()}\n${run.stderr()}`);
    });
    expect(run.stdout()).toContain("answered hello 3 fast 12");

    // The application's own window is shown before the startup window goes: no moment with none.
    await until("the startup window closed", () => ofType(session.log, "Window.Close").some((r) => r.payload.window === STARTUP));
    expect(index(session, "Window.Open", "onlyWindow")).toBeLessThan(index(session, "Window.Close", STARTUP));
    expect(ofType(session.log, "Window.Hide")).toEqual([]);

    // Startup ended: the startup page is gone from the host origin, and on the app's origin the path is the app's.
    const only = await opened(session.log, "onlyWindow");
    expect((await startup.webview.load(only.payload.url as string)).at(-1)!.url).toBe(`${startup.origins.app}/`);
    const late = await startup.read();
    expect(late.status).toBe(404);
    const onApp = (await startup.webview.load(`${startup.origins.app}/startup`)).at(-1)!;
    expect(view(onApp.body)).not.toBe("form");
    expect(onApp.body).not.toContain(secret);

    run.child.kill("SIGTERM");
    await run.exited;
  }, 180_000);

  it("refuses missing inputs under --no-input exactly as ever, with no wait for the window", async () => {
    const session = scratch();
    const run = telo(ASKING, session.env, [], { noInput: true });
    expect(await run.exited).toBe(1);
    const output = run.stdout() + run.stderr();
    expect(output).toContain("DESKTOP_ASKING_GREETING");
    expect(output).toContain("run without `--no-input` to be asked");
    expect(ofType(session.log, "Helper.Quit")).toHaveLength(1);
  }, 120_000);

  it("declines the inputs when the user closes the window while the form waits", async () => {
    const session = scratch();
    const injected = path.join(session.dir, "inject.jsonl");
    const run = telo(ASKING, { ...session.env, FAKE_HELPER_INJECT: injected }, [], { noInput: false });
    const startup = await admitted(session);
    await until("the form", async () => view((await startup.read()).body) === "form");
    inject(injected, "Window.Closed", { window: STARTUP });
    expect(await run.exited).toBe(1);
    expect(run.stdout() + run.stderr()).toContain("DESKTOP_ASKING_GREETING");
  }, 120_000);

  it("ends on SIGTERM while the form waits instead of waiting for a person", async () => {
    const session = scratch();
    const run = telo(ASKING, session.env, [], { noInput: false });
    const startup = await admitted(session);
    await until("the form", async () => view((await startup.read()).body) === "form");
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(1);
    expect(ofType(session.log, "Helper.Quit")).toHaveLength(1);
  }, 120_000);

  it("shows a boot refusal in the window and a 503, prints it too, and exits 1 when the window is closed", async () => {
    const session = scratch();
    const injected = path.join(session.dir, "inject.jsonl");
    const run = telo(FAILING, { ...session.env, FAKE_HELPER_INJECT: injected });
    const startup = await admitted(session);

    const html = await until("the refusal", async () => {
      const hop = await startup.read();
      return view(hop.body) === "refusal" && hop.body;
    });
    expect(html).toContain("could not start");
    expect(html).toContain("division by zero");
    // The diagnostics are printed as ever, and the run waits for the window.
    expect(run.stderr()).toContain("division by zero");
    // A window admitted on the app's origin, which no server takes, is answered 503 with the refusal.
    const unclaimed = (await startup.webview.load(`${startup.origins.app}/anything`)).at(-1)!;
    expect(unclaimed.status).toBe(503);
    expect(view(unclaimed.body)).toBe("refusal");
    expect(run.child.exitCode).toBeNull();

    inject(injected, "Window.Closed", { window: STARTUP });
    expect(await run.exited).toBe(1);
    expect(ofType(session.log, "Helper.Quit")).toHaveLength(1);
  }, 120_000);

  it("exits 1 from a boot refusal when the helper goes away", async () => {
    const session = scratch();
    const run = telo(FAILING, { ...session.env, FAKE_HELPER_EXIT: JSON.stringify({ after: "Window.Open", code: 0 }) });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain("division by zero");
  }, 120_000);

  it("serves every reload of the startup page itself while an app window's connection idles in the pool", async () => {
    const session = scratch();
    const run = telo(STARTING, session.env);
    const startup = await admitted(session);
    const hidden = await opened(session.log, "hiddenWindow");
    const landed = (await startup.webview.load(hidden.payload.url as string)).at(-1)!;
    expect(landed.url).toBe(`${startup.origins.app}/`);
    await until("the app's page", async () => (await startup.webview.load(landed.url)).at(-1)!.status === 200);
    for (let reload = 0; reload < 3; reload++) {
      const page = await startup.read();
      expect(page).toMatchObject({ status: 200, url: `${startup.origins.host}/startup` });
      expect(view(page.body)).toBe("startup");
    }
    // Nothing of the host's ever went on the app's connection: the app saw only its own page.
    expect(startup.webview.on(startup.origins.app).every((hop) => new URL(hop.url).pathname === "/")).toBe(true);
    run.child.kill("SIGTERM");
    await run.exited;
  }, 120_000);

  it("closes the startup window once the application's first visible window is open", async () => {
    const session = scratch();
    const run = telo(APP, session.env);
    await until("the startup window closed", () => ofType(session.log, "Window.Close").some((r) => r.payload.window === STARTUP));
    expect(index(session, "Window.Open", "mainWindow")).toBeLessThan(index(session, "Window.Close", STARTUP));
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("closes the startup window when startup ends and the application opened none visible", async () => {
    const session = scratch();
    const run = telo(TRAY_ONLY, session.env);
    await until("the startup window closed", () => ofType(session.log, "Window.Close").some((r) => r.payload.window === STARTUP));
    expect(ofType(session.log, "Tray.Open")).toHaveLength(1);
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);

  it("does not count the startup window toward what a second start shows", async () => {
    const session = scratch();
    const first = telo(ASKING, session.env, [], { noInput: false });
    await opened(session.log, STARTUP);
    const second = telo(ASKING, session.env, [], { noInput: false });
    expect(await second.exited).toBe(0);
    expect(ofType(session.log, "Window.Show")).toEqual([]);
    first.child.kill("SIGTERM");
    await first.exited;
  }, 120_000);
});

describe.skipIf(process.platform === "win32")("a window the user closes by hiding it", () => {
  it("stops the application with 0 when it was the last visible one and no tray icon is open", async () => {
    const session = scratch();
    const hidden = { after: "Window.Open", type: "Window.Hidden", payload: { window: "onlyWindow" }, delayMs: 300 };
    const run = telo(HIDING, { ...session.env, FAKE_HELPER_EMIT: JSON.stringify([hidden]) });
    expect(await run.exited).toBe(0);
    expect(ofType(session.log, "Window.Hide")).toEqual([]);
  }, 120_000);

  it("leaves the application running while a tray icon is open", async () => {
    const session = scratch();
    const injected = path.join(session.dir, "inject.jsonl");
    const run = telo(APP, { ...session.env, FAKE_HELPER_INJECT: injected });
    await until("the tray", () => ofType(session.log, "Tray.Open").length > 0);
    inject(injected, "Window.Hidden", { window: "mainWindow" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(run.child.exitCode).toBeNull();
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  }, 120_000);
});
