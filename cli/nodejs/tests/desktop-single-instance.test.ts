import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireInstanceLock, alreadyRunningLine, lockEndpoint, type HeldInstanceLock } from "../src/desktop/single-instance-lock.js";

const posix = process.platform !== "win32";

let root: string;
let held: HeldInstanceLock[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-lock-"));
  held = [];
});
afterEach(async () => {
  await Promise.all(held.map((lock) => lock.release()));
  fs.rmSync(root, { recursive: true, force: true });
});

const options = (identifier: string, appDirectory: string, onShowWindows = () => {}) => ({
  identifier,
  appDirectory,
  source: "/work/telo.yaml",
  onShowWindows,
  pid: 48213,
});

async function take(identifier: string, appDirectory: string, onShowWindows?: () => void) {
  const result = await acquireInstanceLock(options(identifier, appDirectory, onShowWindows));
  if (result.acquired) held.push(result);
  return result;
}

describe("the single-instance lock", () => {
  it("is held once; a second start gets the first's process and source, after its windows were shown", async () => {
    let shown = 0;
    const first = await take("run.telo.test.one", root, () => void shown++);
    expect(first.acquired).toBe(true);

    const second = await take("run.telo.test.one", root);
    expect(second).toEqual({ acquired: false, pid: 48213, source: "/work/telo.yaml" });
    expect(shown).toBe(1);
    if (!second.acquired) {
      expect(alreadyRunningLine(second, "Hello")).toBe(
        "Hello is already running (process 48213, /work/telo.yaml); its windows are shown",
      );
    }
  });

  it("is free again once released", async () => {
    const first = await take("run.telo.test.two", root);
    if (first.acquired) await first.release();
    expect((await take("run.telo.test.two", root)).acquired).toBe(true);
  });

  it.skipIf(!posix)("replaces a socket a crashed instance left behind", async () => {
    const directory = path.join(root, "desktop-host");
    fs.mkdirSync(directory, { recursive: true });
    const socket = path.join(directory, "instance.sock");
    const crashed = spawn(
      process.execPath,
      ["-e", `require("net").createServer().listen(process.argv[1], () => console.log("up"))`, socket],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => crashed.stdout.once("data", () => resolve()));
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));
    expect(fs.existsSync(socket)).toBe(true);

    expect((await take("run.telo.test.three", root)).acquired).toBe(true);
  });

  it.skipIf(!posix)("falls back to a short path when the app directory is too deep for a socket", async () => {
    const deep = path.join(root, "x".repeat(60), "y".repeat(60));
    const first = await take("run.telo.test.four", deep);
    expect(first.acquired).toBe(true);
    expect((await take("run.telo.test.four", deep)).acquired).toBe(false);
    expect(fs.existsSync(path.join(deep, "desktop-host", "instance.sock"))).toBe(false);
  });

  it.skipIf(!posix)("falls through to the OS temp directory when $XDG_RUNTIME_DIR is too long for a socket", async () => {
    const deep = path.join(root, "x".repeat(60), "y".repeat(60));
    const runtime = path.join(root, "r".repeat(100));
    fs.mkdirSync(runtime, { recursive: true });
    const lock = await acquireInstanceLock({ ...options("run.telo.test.five", deep), env: { XDG_RUNTIME_DIR: runtime } });
    expect(lock.acquired).toBe(true);
    if (lock.acquired) held.push(lock);
    expect(fs.readdirSync(runtime)).toEqual([]);
  });

  it("names the Windows pipe per user: stable for one directory, different across directories", () => {
    const a = lockEndpoint("run.telo.test.win", "C:\\Users\\a\\desktop-host", "win32", {});
    expect(lockEndpoint("run.telo.test.win", "C:\\Users\\a\\desktop-host", "win32", {})).toBe(a);
    expect(lockEndpoint("run.telo.test.win", "C:\\Users\\b\\desktop-host", "win32", {})).not.toBe(a);
    expect(a).toMatch(/^\\\\\.\\pipe\\telo-desktop-[0-9a-f]{16}$/);
  });

  describe("server errors", () => {
    afterEach(() => vi.restoreAllMocks());

    function capture(): { servers: net.Server[] } {
      const servers: net.Server[] = [];
      const listen = net.Server.prototype.listen;
      vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
        servers.push(this);
        return (listen as (...a: unknown[]) => net.Server).apply(this, args);
      } as typeof net.Server.prototype.listen);
      return { servers };
    }

    it("rejects the acquire when the socket fails before the lock is held", async () => {
      vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server) {
        process.nextTick(() => this.emit("error", new Error("socket broke")));
        return this;
      } as typeof net.Server.prototype.listen);
      await expect(take("run.telo.test.err1", root)).rejects.toThrow("socket broke");
    });

    it("reports a later error to onError, and throws it when none was supplied", async () => {
      const { servers } = capture();
      const seen: Error[] = [];
      const reported = await acquireInstanceLock({ ...options("run.telo.test.err2", root), onError: (e) => seen.push(e) });
      if (reported.acquired) held.push(reported);
      servers[0].emit("error", new Error("late"));
      expect(seen.map((e) => e.message)).toEqual(["late"]);

      const bare = await take("run.telo.test.err3", path.join(root, "other"));
      expect(bare.acquired).toBe(true);
      expect(() => servers[1].emit("error", new Error("unhandled"))).toThrow("unhandled");
    });
  });
});
