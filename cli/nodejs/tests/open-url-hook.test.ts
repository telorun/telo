import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openBrowser, openerFor } from "../src/open-browser.js";
import { createOpenUrlHook } from "../src/open-url-hook.js";
import { Output, installOutput } from "../src/output.js";

const tty = { isTTY: true };
const consentUrl = "https://auth.example.com/consent?client=a%20b&scope=x%2Fy&state=1";

const watchedEvents = ["data", "readable", "keypress", "end"];

function recordedStdin() {
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.isTTY = true;
  stdin.resume = vi.fn();
  stdin.read = vi.fn();
  stdin.setRawMode = vi.fn();
  stdin.isPaused = vi.fn(() => true);
  return stdin as EventEmitter & {
    isTTY: boolean;
    resume: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    setRawMode: ReturnType<typeof vi.fn>;
    isPaused: ReturnType<typeof vi.fn>;
  };
}

function recordedStderr() {
  const errors: string[] = [];
  const restore = installOutput(
    new Output({
      format: "text",
      stdout: { write: () => true },
      stderr: { write: (c: string) => errors.push(c) },
      env: {},
    }),
  );
  return { errors, restore };
}

function openerChild() {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

describe("createOpenUrlHook", () => {
  it("installs no hook without a terminal or with --no-input", () => {
    expect(createOpenUrlHook({ stdin: { isTTY: false }, stderr: tty })).toBeUndefined();
    expect(createOpenUrlHook({ stdin: tty, stderr: {} })).toBeUndefined();
    expect(createOpenUrlHook({ input: false, stdin: tty, stderr: tty })).toBeUndefined();
  });

  it("opens the same URL once and two different URLs both", () => {
    const open = vi.fn();
    const hook = createOpenUrlHook({ stdin: tty, stderr: tty, open })!;
    hook("http://localhost:8080/");
    hook("http://localhost:8080/");
    hook(consentUrl);
    expect(open.mock.calls.map((c) => c[0])).toEqual(["http://localhost:8080/", consentUrl]);
  });

  it("emits every call and only emits with no terminal", () => {
    const open = vi.fn();
    const emit = vi.fn();
    const headless = createOpenUrlHook({ input: false, stdin: tty, stderr: tty, open, emit })!;
    headless("http://localhost:1/");
    headless("http://localhost:1/");
    expect(emit.mock.calls).toEqual([["http://localhost:1/"], ["http://localhost:1/"]]);
    expect(open).not.toHaveBeenCalled();

    const emitted = vi.fn();
    const attended = createOpenUrlHook({ stdin: tty, stderr: tty, open, emit: emitted })!;
    attended("http://localhost:2/");
    attended("http://localhost:2/");
    expect(emitted).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("leaves stdin alone while an app-side reader receives every line in order", () => {
    const stdin = recordedStdin();
    const received: string[] = [];
    stdin.on("data", (line: string) => received.push(line));
    const counts = () => watchedEvents.map((name) => stdin.listenerCount(name));
    const before = counts();
    const pausedBefore = stdin.isPaused();
    const open = vi.fn();
    const hook = createOpenUrlHook({ stdin, stderr: tty, open })!;
    for (const [i, url] of ["http://localhost:1/", "http://localhost:2/"].entries()) {
      stdin.emit("data", `line ${i}`);
      hook(url);
    }
    stdin.emit("data", "last");
    expect(open).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["line 0", "line 1", "last"]);
    expect(counts()).toEqual(before);
    expect(stdin.isPaused()).toBe(pausedBefore);
    expect(stdin.resume).not.toHaveBeenCalled();
    expect(stdin.read).not.toHaveBeenCalled();
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });
});

describe("openerFor", () => {
  it.each([
    ["linux", "xdg-open", [consentUrl]],
    ["darwin", "open", [consentUrl]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", consentUrl]],
  ] as const)("%s passes the URL as one unchanged argument", (platform, command, args) => {
    expect(openerFor(consentUrl, platform, {})).toEqual({ command, args });
  });

  it("prefers $BROWSER as one executable", () => {
    expect(openerFor(consentUrl, "linux", { BROWSER: "/opt/my browser:x" })).toEqual({
      command: "/opt/my browser:x",
      args: [consentUrl],
    });
  });
});

describe("openBrowser", () => {
  it("spawns detached without stdio and unrefs", () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => child as never);
    openBrowser(consentUrl, { platform: "linux", env: {}, spawn });
    expect(spawn).toHaveBeenCalledWith("xdg-open", [consentUrl], { stdio: "ignore", detached: true });
    expect(child.unref).toHaveBeenCalled();
  });

  it("prints the reason and the URL once on stderr when the launch fails", () => {
    const { errors, restore } = recordedStderr();
    try {
      const child = openerChild();
      openBrowser("http://localhost:8080", {
        platform: "linux",
        env: { BROWSER: "/nonexistent" },
        spawn: () => child as never,
      });
      child.emit("error", new Error("spawn /nonexistent ENOENT"));
    } finally {
      restore();
    }
    expect(errors).toEqual([
      "Could not open a browser (spawn /nonexistent ENOENT). Open http://localhost:8080 yourself.\n",
    ]);
  });

  it("prints the exit code and the URL once when the opener exits non-zero", () => {
    const { errors, restore } = recordedStderr();
    try {
      const child = openerChild();
      openBrowser("http://localhost:8080", { platform: "linux", env: {}, spawn: () => child as never });
      child.emit("exit", 3, null);
    } finally {
      restore();
    }
    expect(errors).toEqual([
      "Could not open a browser (xdg-open exited with code 3). Open http://localhost:8080 yourself.\n",
    ]);
  });

  it("prints the signal and the URL once when the opener is killed", () => {
    const { errors, restore } = recordedStderr();
    try {
      const child = openerChild();
      openBrowser("http://localhost:8080", { platform: "linux", env: {}, spawn: () => child as never });
      child.emit("exit", null, "SIGKILL");
    } finally {
      restore();
    }
    expect(errors).toEqual([
      "Could not open a browser (xdg-open was stopped by SIGKILL). Open http://localhost:8080 yourself.\n",
    ]);
  });

  it("prints nothing when the opener exits zero", () => {
    const { errors, restore } = recordedStderr();
    try {
      const child = openerChild();
      openBrowser("http://localhost:8080", { platform: "linux", env: {}, spawn: () => child as never });
      child.emit("exit", 0, null);
    } finally {
      restore();
    }
    expect(errors).toEqual([]);
  });
});
