import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The contract `-o json` exists to provide: stdout is exactly one parseable
 * document, or empty. Asserted end-to-end per command, because every way this
 * can break — writing an envelope onto a stream someone else owns, letting
 * prose share stdout, emitting nothing at all — is invisible to a unit test of
 * the seam and shows up only in what the process actually writes.
 *
 * Network-free commands only. `run`, `install`, `publish` and `upgrade` reach
 * the network or a registry; their shapes are covered by the seam's unit tests.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const MODULE = path.join(ROOT, "modules/run");

/** On Windows `bun` on PATH is `bun.CMD` (pnpm's shim): libuv's executable search
 *  probes only `.com`/`.exe`, and Node has refused to spawn `.cmd`/`.bat` without
 *  a shell since CVE-2024-27980 — so this spawn produced no stdout at all and
 *  every case below failed as "expected '' not to be ''". Going through cmd.exe
 *  makes quoting ours: Node joins the argv with spaces and quotes nothing, and
 *  these arguments are absolute paths that may contain one. The command itself
 *  stays bare, because quoting it would leave a batch shim's `%~dp0` resolving
 *  against the cwd rather than its own directory. */
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args].map(quote), {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
      // Would colour the output if any escape leaked into the machine surface.
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), status: err.status ?? 1 };
  }
}

const CASES: Array<{ name: string; args: string[] }> = [
  { name: "check (clean)", args: ["check", "-o", "json", path.join(MODULE, "telo.yaml")] },
  { name: "cel eval", args: ["cel", "eval", "-o", "json", "1 + 2"] },
  { name: "cel functions", args: ["cel", "functions", "-o", "json"] },
  { name: "module versions", args: ["module", "versions", "-o", "json", MODULE] },
  { name: "module kinds", args: ["module", "kinds", "-o", "json", MODULE] },
  { name: "module resources", args: ["module", "resources", "-o", "json", MODULE] },
];

describe("-o json output contract", () => {
  it.each(CASES)("$name emits one parseable document on stdout", ({ args }) => {
    const { stdout } = runCli(args);
    expect(stdout.trim()).not.toBe("");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it.each(CASES)("$name puts no escape sequences on stdout", ({ args }) => {
    expect(runCli(args).stdout).not.toContain("\x1b[");
  });

  it("check reports failures as data, not prose, and still exits non-zero", () => {
    const bad = path.join(ROOT, "cli/nodejs/tests/__fixtures__/unresolvable-import.yaml");
    const { stdout, status } = runCli(["check", "-o", "json", bad]);
    const payload = JSON.parse(stdout);
    expect(status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.errorCount).toBeGreaterThan(0);
    // The point of the format: a consumer branches on the code, never the prose.
    expect(payload.diagnostics[0]).toMatchObject({ severity: "error" });
    expect(typeof payload.diagnostics[0].code).toBe("string");
  });

  it("run does not write an envelope, because the app owns both streams", () => {
    // `teeStdio` copies rather than redirects, so app output shares these
    // descriptors. A trailing envelope would make stdout unparseable — the
    // exemption is the contract, so assert it rather than leaving it to prose.
    const app = path.join(ROOT, "cli/nodejs/tests/__fixtures__/prints-and-exits.yaml");
    const { stdout } = runCli(["run", "-o", "json", app]);
    expect(stdout).toContain("hello from the app");
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
