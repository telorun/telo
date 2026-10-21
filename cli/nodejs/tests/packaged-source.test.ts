import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeTrailer, payloadDigest } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";

/**
 * A packaged executable handed to a command in place of a manifest, end to end:
 * the command reads the payload's unpacked entry, executes nothing the payload
 * carries, and answers exactly as it does for that entry.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const FIXTURE = path.join(ROOT, "cli/nodejs/tests/__fixtures__/packaged-source");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

let dir: string;
let executable: string;
let unpackedEntry: string;

function runCli(args: string[], cwd = ROOT): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args].map(quote), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
      env: { ...process.env, TELO_APP_DIR: path.join(dir, "apps-root") },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.status ?? 1 };
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-packaged-source-"));
  const { payload, index } = await buildAppPayload({
    manifestPath: FIXTURE,
    platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
    report: () => {},
  });
  // A carrier's own bytes, then the payload and its trailer — what `telo
  // package` writes for every platform but darwin.
  executable = path.join(dir, "announcer");
  fs.writeFileSync(executable, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
  unpackedEntry = path.join(
    dir,
    "apps-root",
    "apps",
    `${index.app.name}-${payloadDigest(payload).slice(0, 16)}`,
    index.entry,
  );
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a packaged executable as a manifest source", () => {
  it("describes byte for byte as its unpacked entry does, text and JSON, running nothing it carries", () => {
    for (const format of [[], ["-o", "json"]]) {
      const packaged = runCli(["describe", ...format, executable]);
      expect(packaged.status, packaged.stderr).toBe(0);
      const unpacked = runCli(["describe", ...format, unpackedEntry]);
      expect(unpacked.status, unpacked.stderr).toBe(0);
      expect(packaged.stdout).toBe(unpacked.stdout);
    }
    expect(runCli(["describe", executable]).stdout).toContain("variables.greeting  env GREETING");
  });

  it("writes the environment template where the application reads its env files: the working directory", () => {
    const workdir = path.join(dir, "deploy");
    fs.mkdirSync(workdir);
    const result = runCli(["env", "template", "--write", executable], workdir);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(workdir, ".env"), "utf8")).toMatch(/^# GREETING=hello/m);
    expect(fs.existsSync(path.join(path.dirname(unpackedEntry), ".env"))).toBe(false);
  });
});
