import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(PACKAGE_DIR, "src/entry.ts");

describe("telo-host-runner", () => {
  it("refuses RUNNER_SESSION_USER before any work with exit 2, naming it", async () => {
    const outcome = await promisify(execFile)("bun", [ENTRY, "--port", "0"], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, RUNNER_SESSION_USER: "2000:2000" },
    }).then(
      () => ({ code: 0, stderr: "" }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code, stderr: String(err.stderr ?? "") }),
    );
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain(
      "telo-host-runner: RUNNER_SESSION_USER is set ('2000:2000'), but this runner runs no containers",
    );
  });
});
