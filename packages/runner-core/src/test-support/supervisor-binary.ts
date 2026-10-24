import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SUPERVISOR_VECTORS = join(REPO_ROOT, "packages/runner-core/supervisor/vectors");

/** Why the real supervisor cannot run here, or `undefined` when it can. */
export function supervisorUnavailable(): string | undefined {
  if (process.platform !== "linux") return `the session supervisor runs on Linux only (this is ${process.platform})`;
  if (process.env.TELO_SUPERVISOR_BIN) return undefined;
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  if (cargo.error || cargo.status !== 0) return "cargo is not installed, and TELO_SUPERVISOR_BIN names no prebuilt supervisor";
  return undefined;
}

/** `TELO_SUPERVISOR_BIN`, or the crate built in the workspace's debug profile. */
export function supervisorBinary(): string {
  if (process.env.TELO_SUPERVISOR_BIN) return process.env.TELO_SUPERVISOR_BIN;
  const build = spawnSync(
    "cargo",
    ["build", "--locked", "-p", "telo-runner-supervisor", "--bin", "supervisor", "--message-format=json"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (build.status !== 0) throw new Error(`building the supervisor failed:\n${build.stderr}`);
  for (const line of build.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as { reason?: string; executable?: string | null; target?: { name?: string } };
    if (message.reason === "compiler-artifact" && message.target?.name === "supervisor" && message.executable) {
      return message.executable;
    }
  }
  throw new Error("cargo built no supervisor executable");
}

export interface RunningSupervisor {
  host: string;
  port: number;
  token: string;
  child: ChildProcess;
  workspace: string;
  log(): string;
  stop(): Promise<void>;
}

/** Starts one supervisor on a free loopback port over a fresh workspace. */
export async function startSupervisor(
  binary: string,
  files: Record<string, string> = {},
  token = "test-token",
): Promise<RunningSupervisor> {
  const workspace = mkdtempSync(join(tmpdir(), "telo-supervisor-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
  const child = spawn(binary, ["--workspace", workspace], {
    env: { ...process.env, TELO_SUPERVISOR_LISTEN: "127.0.0.1:0", TELO_SUPERVISOR_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const lines: string[] = [];
  const address = await new Promise<string>((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error(`the supervisor never listened:\n${lines.join("\n")}`)), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      lines.push(line);
      const match = /^supervisor info: listening on (.+)$/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolveAddress(match[1]!);
      }
    });
  });
  const separator = address.lastIndexOf(":");
  return {
    host: address.slice(0, separator),
    port: Number(address.slice(separator + 1)),
    token,
    child,
    workspace,
    log: () => lines.join("\n"),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => {
          child.once("exit", () => done());
          child.kill("SIGKILL");
        });
      }
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
