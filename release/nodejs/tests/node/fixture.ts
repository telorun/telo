import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yargs from "yargs";
import { SHIPPED_ADAPTERS, type EcosystemAdapter } from "../../src/index.js";
import { releaseCommands } from "../../src/node/commands.js";
import type { EvidenceAdapter } from "../../src/node/evidence.js";
import type { ReleaseHost, ReleaseOutput, Style } from "../../src/node/host.js";
import { SHIPPED_EVIDENCE } from "../../src/node/index.js";

export function tempRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telorun-release-")));
  write(root, files);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "init");
  return root;
}

export function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

export function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

const plain: Style = { ok: (t) => t, dim: (t) => t, error: (t) => t, warn: (t) => t };

export interface Recorded {
  stdout: string[];
  stderr: string[];
  payloads: Record<string, unknown>[];
}

export function host(options: { adapters?: EcosystemAdapter[]; evidence?: EvidenceAdapter[] } = {}): {
  host: ReleaseHost;
  recorded: Recorded;
} {
  const recorded: Recorded = { stdout: [], stderr: [], payloads: [] };
  const output: ReleaseOutput = {
    line: (text) => recorded.stdout.push(text),
    errLine: (text) => recorded.stderr.push(text),
    emit: (payload) => recorded.payloads.push(payload),
    progress: () => {},
    style: plain,
    errStyle: plain,
  };
  return {
    recorded,
    host: {
      command: "telo-release",
      adapters: options.adapters ?? [...SHIPPED_ADAPTERS],
      evidence: options.evidence ?? [...SHIPPED_EVIDENCE],
      output: () => output,
    },
  };
}

/** Run one command line in `root`; returns the last envelope and the exit code. */
export async function run(
  releaseHost: ReleaseHost,
  recorded: Recorded,
  root: string,
  args: string[],
): Promise<{ payload: Record<string, unknown>; exitCode: number }> {
  const cwd = process.cwd();
  process.exitCode = 0;
  process.chdir(root);
  try {
    await releaseCommands(yargs(args), releaseHost).fail((message, error) => {
      throw error ?? new Error(message);
    }).parseAsync();
  } finally {
    process.chdir(cwd);
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { payload: recorded.payloads[recorded.payloads.length - 1] ?? {}, exitCode };
}

export function has(command: string, args: string[] = ["--version"], cwd?: string): string | undefined {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
