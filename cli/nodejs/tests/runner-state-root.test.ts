import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveStateRoot } from "../src/runner/state-root.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/telo.ts");

describe("the local runner's state root", () => {
  it("is --state-dir, then RUNNER_STATE_DIR, then the platform's per-user state directory", () => {
    const env = { RUNNER_STATE_DIR: "/srv/runner", XDG_STATE_HOME: "/xdg", HOME: "/home/me" };
    expect(resolveStateRoot("state", env, "linux", "/work")).toEqual({ root: "/work/state", from: "--state-dir" });
    expect(resolveStateRoot(undefined, env, "linux", "/work")).toEqual({ root: "/srv/runner", from: "RUNNER_STATE_DIR" });

    const linux = (env: NodeJS.ProcessEnv) => resolveStateRoot(undefined, env, "linux", "/work");
    expect(linux({ XDG_STATE_HOME: "/xdg", HOME: "/home/me" })).toEqual({ root: "/xdg/telo/runner", from: "default" });
    expect(linux({ XDG_STATE_HOME: "relative", HOME: "/home/me" })).toEqual({
      root: "/home/me/.local/state/telo/runner",
      from: "default",
    });
    expect(resolveStateRoot(undefined, { HOME: "/Users/me" }, "darwin", "/work")).toEqual({
      root: "/Users/me/Library/Application Support/telo/runner",
      from: "default",
    });
    expect(resolveStateRoot(undefined, { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\work")).toEqual({
      root: "C:\\Users\\me\\AppData\\Local\\telo\\state\\runner",
      from: "default",
    });
  });

  it("is refused, naming both settings, when no default can be placed", () => {
    for (const [env, platform] of [
      [{}, "linux"],
      [{}, "darwin"],
      [{ HOME: "C:\\Users\\me" }, "win32"],
    ] as const) {
      const resolution = resolveStateRoot(undefined, env, platform, "/work");
      expect(resolution, platform).toEqual({ refusal: expect.stringMatching(/--state-dir .*RUNNER_STATE_DIR/) });
    }
  });

  // Spawned on POSIX only: Windows always has a LOCALAPPDATA to fall back on.
  it.skipIf(process.platform === "win32")("holds the session store and the session directories, and is the directory the command reports", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-runner-root-"));
    try {
      const runner = spawn("bun", [CLI, "-o", "json", "runner", "--port", "0"], {
        env: { ...process.env, RUNNER_STATE_DIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          runner.stdout.on("data", (chunk) => {
            stdout += chunk;
            // The result is one JSON document, written once the runner listens.
            const end = stdout.indexOf("\n}");
            if (end >= 0) resolve(JSON.parse(stdout.slice(stdout.indexOf("{"), end + 2)));
          });
          runner.stderr.on("data", (chunk) => (stderr += chunk));
          runner.on("exit", (code) => reject(new Error(`telo runner exited ${code}: ${stderr}`)));
        });
        expect(result.stateDir).toBe(root);
        expect(fs.existsSync(path.join(root, "sessions.sqlite"))).toBe(true);
        expect(fs.statSync(path.join(root, "sessions")).isDirectory()).toBe(true);
      } finally {
        runner.kill("SIGTERM");
        await new Promise((resolve) => runner.once("exit", resolve));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("refuses to start with no HOME and nothing named, saying how to name one", async () => {
    const { HOME, XDG_STATE_HOME, RUNNER_STATE_DIR, ...rest } = process.env;
    const runner = spawn("bun", [CLI, "runner", "--port", "0"], { env: rest, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    runner.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => runner.once("exit", resolve));
    expect(code).toBe(2);
    expect(stderr).toMatch(/telo runner: no state directory: .*--state-dir <dir> or RUNNER_STATE_DIR/);
  }, 60_000);
});
