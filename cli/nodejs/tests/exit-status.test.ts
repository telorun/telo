import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/telo.ts");
// On Windows `bun` is a `.cmd` shim, spawned through cmd.exe, which quotes nothing.
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);
const execFileAsync = promisify(execFile);

async function telo(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bun", [CLI, ...args].map(quote), {
      encoding: "utf8",
      shell: VIA_CMD,
    });
    return { stdout, stderr, status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.code ?? 1 };
  }
}

/** 0 the work was done, 1 it failed, 2 the invocation was refused. */
describe("exit status", () => {
  it("is 2 for a command line the parser refuses, with the usage and the reason on stderr and nothing on stdout", async () => {
    for (const [args, reason] of [
      [["check", "x.yaml", "--bogus"], /Unknown argument: bogus$/],
      [["module"], /Not enough non-option arguments: got 0, need at least 1$/],
      [["module", "nope"], /Specify a module subcommand/],
      [["check"], /Not enough non-option arguments: got 0, need at least 1$/],
      [["check", "-o", "yaml", "x.yaml"], /Invalid values:[\s\S]*Argument: output, Given: "yaml"/],
    ] as const) {
      const refused = await telo([...args]);
      expect(refused.status, args.join(" ")).toBe(2);
      expect(refused.stdout, args.join(" ")).toBe("");
      expect(refused.stderr, args.join(" ")).toMatch(/^telo /);
      expect(refused.stderr.trimEnd(), args.join(" ")).toMatch(reason);
    }
  }, 60_000);

  it("is 1 when the command's work fails, reported as one line rather than a stack", async () => {
    for (const args of [
      ["check", "no-such-manifest.yaml"],
      ["describe", "no-such-manifest.yaml"],
      ["needs", "report", "no-such-manifest.yaml"],
      ["env", "template", "no-such-manifest.yaml"],
    ]) {
      const failed = await telo(args);
      expect(failed.status, args.join(" ")).toBe(1);
      expect(failed.stderr, args.join(" ")).toMatch(/^no-such-manifest\.yaml {2}.*error.* {2}ENOENT/m);
      expect(failed.stderr, args.join(" ")).not.toMatch(/^\s+at /m);
    }
  }, 60_000);

  it("is 0 for --version and --help", async () => {
    expect((await telo(["--version"])).status).toBe(0);
    expect((await telo(["--help"])).status).toBe(0);
  }, 30_000);
});
