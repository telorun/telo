import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { inheritedEnvironment } from "../src/runner/app-process.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PACKAGE_DIR, "bin", "telo-host-runner.mjs");
const execFileAsync = promisify(execFile);

/** A loader hook that reports every server-stack package the process resolves. */
const WATCH_SERVER_STACK =
  "data:text/javascript," +
  encodeURIComponent(
    `import { register } from "node:module";
     register("data:text/javascript," + encodeURIComponent(
       'import { writeSync } from "node:fs";' +
       'export async function resolve(s, c, next) {' +
       '  if (/^(fastify|pino|ws)$/.test(s)) writeSync(2, "LOADED " + s + "\\\\n");' +
       '  return next(s, c);' +
       '}'));`,
  );

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", WATCH_SERVER_STACK, BIN, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  }).catch((err: { stdout?: string; stderr?: string }) => ({
    stdout: String(err.stdout ?? ""),
    stderr: String(err.stderr ?? ""),
  }));
}

describe("the runner's entry", () => {
  beforeAll(async () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    await execFileAsync(process.execPath, [tsc, "-p", PACKAGE_DIR]);
  }, 120_000);

  it("hands a leading `telo` to the bundled CLI before the server stack is loaded", async () => {
    const reEntry = await run(["telo", "--version"]);
    expect(reEntry.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(\+unreleased)?$/);
    expect(reEntry.stderr).not.toContain("LOADED");

    // The same loader sees the server stack when the runner itself starts.
    const runner = await run(["--host", "0.0.0.0"]);
    expect(runner.stderr).toContain("LOADED fastify");
  }, 60_000);
});

describe("a process the runner spawns", () => {
  it("inherits no TELO_APP_CLI", () => {
    const inherited = inheritedEnvironment({ TELO_APP_CLI: "1", PATH: "/bin" });
    expect(inherited).toEqual({ PATH: "/bin" });
  });

  it("inherits no TELO_APP_CLI a client's env supplies", () => {
    const inherited = inheritedEnvironment({ PATH: "/bin" }, { TELO_APP_CLI: "0", FOO: "bar" });
    expect(inherited).toEqual({ PATH: "/bin", FOO: "bar" });
  });

  it("inherits none of the runner's own host values, only the run's", () => {
    const inherited = inheritedEnvironment(
      { PATH: "/bin", TELO_HOST_SECRET_SEED: "operator", TELO_HOST_STATE_DIR: "/operator", RUNNER_SECRET_SEED: "root" },
      { TELO_HOST_STATE_DIR: "/session/apps/web" },
    );
    expect(inherited).toEqual({ PATH: "/bin", TELO_HOST_STATE_DIR: "/session/apps/web" });
  });
});
