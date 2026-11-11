import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DesktopHelper,
  DesktopHelperGone,
  DesktopHelperRequestError,
  type HelperExit,
} from "../src/desktop/desktop-helper-client.js";
import type { HelperInit } from "../src/desktop/desktop-helper-messages.js";

const FAKE = path.join(import.meta.dirname, "__fixtures__", "desktop-helper", "fake-desktop-helper.mjs");
const VERSION = "0.133.0";
const INIT: HelperInit = {
  identifier: "run.telo.test",
  productName: "Test",
  origin: "http://127.0.0.1:53817",
  hostOrigin: "http://127.0.0.1:53900",
  webviewDirectory: "/tmp/webview",
  showInDock: false,
};

let directory: string;
let started: DesktopHelper[];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "telo-helper-client-"));
  started = [];
});
afterEach(async () => {
  await Promise.all(started.map((helper) => helper.quit().catch(() => undefined)));
  fs.rmSync(directory, { recursive: true, force: true });
});

const logFile = () => path.join(directory, "requests.jsonl");
const received = () =>
  fs
    .readFileSync(logFile(), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: number; type: string; payload: unknown });

function helper(fakeEnv: Record<string, string> = {}, stderr: string[] = [], quitTimeoutMs?: number): DesktopHelper {
  const instance = new DesktopHelper({
    command: FAKE,
    version: VERSION,
    init: INIT,
    log: (line) => stderr.push(line),
    quitTimeoutMs,
    env: { ...process.env, FAKE_HELPER_VERSION: VERSION, FAKE_HELPER_LOG: logFile(), ...fakeEnv },
  });
  started.push(instance);
  return instance;
}

const unavailable = (message: string) => ({ code: "ERR_DESKTOP_HOST_UNAVAILABLE", message: `cannot start the desktop host: ${message}` });

describe.skipIf(process.platform === "win32")("the desktop helper link", () => {
  describe("starting", () => {
    it("is ready after Helper.Ready and Helper.Init, reports tray availability and forwards stderr", async () => {
      const stderr: string[] = [];
      const h = helper({ FAKE_HELPER_TRAY: "false" }, stderr);
      await h.start();
      expect(h.trayAvailable).toBe(false);
      expect(received()).toEqual([{ id: 1, type: "Helper.Init", payload: INIT }]);
      // stderr is its own pipe, so its line may land just after the frames on stdout.
      await vi.waitFor(() => expect(stderr).toContain("fake-helper: ready"));
    });

    it("refuses a helper of another version", async () => {
      await expect(helper({ FAKE_HELPER_VERSION: "0.0.1" }).start()).rejects.toMatchObject(
        unavailable("the helper is version 0.0.1 but this telo is 0.133.0; they must be the same release"),
      );
    });

    it("reports Helper.Unavailable's reason", async () => {
      await expect(helper({ FAKE_HELPER_MODE: "unavailable" }).start()).rejects.toMatchObject(
        unavailable("no webview runtime"),
      );
    });

    it("reports a helper that exits before Helper.Ready, with its last stderr line", async () => {
      await expect(helper({ FAKE_HELPER_MODE: "exit-before-ready" }).start()).rejects.toMatchObject(
        unavailable("the helper exited with code 1 before it was ready (fake-helper: exiting before Ready)"),
      );
    });

    it("reports a helper that cannot be spawned", async () => {
      const missing = new DesktopHelper({ command: path.join(directory, "nope"), version: VERSION, init: INIT, log: () => {} });
      await expect(missing.start()).rejects.toMatchObject({ code: "ERR_DESKTOP_HOST_UNAVAILABLE" });
    });

    it("reports a refused Helper.Init", async () => {
      const refused = { "Helper.Init": { code: "ERR_DESKTOP_HELPER_ALREADY_INITIALIZED", message: "again" } };
      await expect(helper({ FAKE_HELPER_ERRORS: JSON.stringify(refused) }).start()).rejects.toMatchObject({
        code: "ERR_DESKTOP_HOST_UNAVAILABLE",
        message: expect.stringContaining("ERR_DESKTOP_HELPER_ALREADY_INITIALIZED"),
      });
    });
  });

  describe("requests", () => {
    it("sends each request with an odd id and the payload its table lists", async () => {
      const h = helper();
      await h.start();
      const open = { window: "main", url: "http://127.0.0.1:53900/admit?code=c", resizable: true, visible: false, onClose: "hide" as const };
      const tray = { tray: "t", icon: "/i.png", monochrome: true, menu: [{ type: "item" as const, item: 0, label: "Open", enabled: true }] };
      await h.openWindow(open);
      await h.showWindow("main");
      await h.hideWindow("main");
      await h.focusWindow("main");
      await h.navigateWindow("main", "http://127.0.0.1:53817/a");
      await h.closeWindow("main");
      expect(await h.openTray(tray)).toEqual({ available: true });
      await h.closeTray("t");

      expect(received().slice(1)).toEqual([
        { id: 3, type: "Window.Open", payload: open },
        { id: 5, type: "Window.Show", payload: { window: "main" } },
        { id: 7, type: "Window.Hide", payload: { window: "main" } },
        { id: 9, type: "Window.Focus", payload: { window: "main" } },
        { id: 11, type: "Window.Navigate", payload: { window: "main", url: "http://127.0.0.1:53817/a" } },
        { id: 13, type: "Window.Close", payload: { window: "main" } },
        { id: 15, type: "Tray.Open", payload: tray },
        { id: 17, type: "Tray.Close", payload: { tray: "t" } },
      ]);
    });

    it("answers a refused request with the helper's code and message", async () => {
      const errors = { "Window.Show": { code: "ERR_DESKTOP_HOST_UNKNOWN_ENTRY", message: "no window 'x'" } };
      const h = helper({ FAKE_HELPER_ERRORS: JSON.stringify(errors) });
      await h.start();
      await expect(h.showWindow("x")).rejects.toMatchObject({
        constructor: DesktopHelperRequestError,
        code: "ERR_DESKTOP_HOST_UNKNOWN_ENTRY",
      });
    });

    it("reports a tray the session cannot show as unavailable", async () => {
      const h = helper({ FAKE_HELPER_TRAY: "false" });
      await h.start();
      expect(await h.openTray({ tray: "t", icon: "/i.png", monochrome: false, menu: [] })).toEqual({ available: false });
    });
  });

  describe("notifications", () => {
    it("reaches the listener of each, with its payload", async () => {
      const emit = [
        ["Helper.QuitRequested", {}],
        ["Helper.Reopened", {}],
        ["Window.Closed", { window: "w" }],
        ["Window.Hidden", { window: "w" }],
        ["Window.OpenRequested", { fromWindow: "w", url: "http://127.0.0.1:53817/x" }],
        ["Navigation.External", { window: "w", url: "https://id.example.com/a" }],
        ["Tray.ItemChosen", { tray: "t", item: 2 }],
        ["Tray.Clicked", { tray: "t" }],
      ] as const;
      const h = helper({ FAKE_HELPER_EMIT: JSON.stringify(emit.map(([type, payload]) => ({ after: "Helper.Init", type, payload }))) });
      const seen: Array<[string, unknown]> = [];
      h.on("quitRequested", (e) => seen.push(["Helper.QuitRequested", e]));
      h.on("reopened", (e) => seen.push(["Helper.Reopened", e]));
      h.on("windowClosed", (e) => seen.push(["Window.Closed", e]));
      h.on("windowHidden", (e) => seen.push(["Window.Hidden", e]));
      h.on("windowOpenRequested", (e) => seen.push(["Window.OpenRequested", e]));
      h.on("navigationExternal", (e) => seen.push(["Navigation.External", e]));
      h.on("trayItemChosen", (e) => seen.push(["Tray.ItemChosen", e]));
      h.on("trayClicked", (e) => seen.push(["Tray.Clicked", e]));
      await h.start();
      await h.showWindow("w");
      expect(seen).toEqual(emit.map(([type, payload]) => [type, payload]));
    });
  });

  describe("ending", () => {
    it("surfaces a helper ending on its own as one exited event, and fails what is still asked", async () => {
      const h = helper({ FAKE_HELPER_EXIT: JSON.stringify({ after: "Window.Show", code: 0 }) });
      const exits: HelperExit[] = [];
      h.on("exited", (e) => exits.push(e));
      await h.start();
      await h.showWindow("w");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exits).toEqual([{ reason: "ended", code: 0, signal: null }]);
      await expect(h.showWindow("w")).rejects.toBeInstanceOf(DesktopHelperGone);
    });

    it("is quit by quit(), which waits for exit 0 and raises no exited event", async () => {
      const h = helper();
      const exits: HelperExit[] = [];
      h.on("exited", (e) => exits.push(e));
      await h.start();
      await h.quit();
      expect(received().at(-1)).toMatchObject({ type: "Helper.Quit", payload: {} });
      expect(exits).toEqual([]);
    });

    it("kills a helper that never answers Helper.Quit within the timeout", async () => {
      const h = helper({ FAKE_HELPER_MODE: "ignore-quit" }, [], 300);
      await h.start();
      const began = Date.now();
      await h.quit();
      expect(Date.now() - began).toBeLessThan(3000);
      await expect(h.showWindow("w")).rejects.toBeInstanceOf(DesktopHelperGone);
    });

    it.each(["violate-odd-notification", "violate-unknown-type", "violate-extra-member", "violate-data-frame"])(
      "treats %s as terminal: one exited event, and every later request fails",
      async (mode) => {
        const h = helper({ FAKE_HELPER_MODE: mode });
        const exits: HelperExit[] = [];
        h.on("exited", (e) => exits.push(e));
        await h.start();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(exits).toHaveLength(1);
        expect(exits[0]).toMatchObject({ reason: "violation" });
        await expect(h.showWindow("w")).rejects.toBeInstanceOf(DesktopHelperGone);
      },
    );
  });
});
