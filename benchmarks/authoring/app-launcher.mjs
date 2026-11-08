// Boots a built app outside the container, as a user would, on a fresh STATE_DIR, and runs the
// contract tests against it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS, repoRoot } from "./tasks.mjs";

const windows = process.platform === "win32";

// `TELO_COMMAND` may be several words (`bun path/to/telo.ts`); the default is the telo on PATH.
export const teloCommand = () => (process.env.TELO_COMMAND ?? "telo").trim().split(/\s+/);

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function runToEnd(command, args, options) {
  const run = spawnSync(command, args, { encoding: "utf8", shell: windows, maxBuffer: 64 * 1024 * 1024, ...options });
  if (run.error) throw run.error;
  return run;
}

async function waitForPing(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before it answered /ping`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the app did not answer /ping within ${Math.round(timeoutMs / 1000)}s`);
}

export const appLauncher = {
  // Installs what an agent left uninstalled and builds; throws with the tool's output on failure.
  prepare(workspace, side) {
    if (side !== "node") return;
    if (!existsSync(join(workspace, "package.json"))) throw new Error("the Node app has no package.json");
    const steps = existsSync(join(workspace, "node_modules"))
      ? [["run", "build", "--if-present"]]
      : [["install", "--no-audit", "--no-fund"], ["run", "build", "--if-present"]];
    for (const args of steps) {
      const run = runToEnd("npm", args, { cwd: workspace });
      if (run.status !== 0) throw new Error(`npm ${args.join(" ")} failed (exit ${run.status}):\n${run.stdout}${run.stderr}`);
    }
  },

  async start(workspace, side, { port, readyTimeoutMs = 180_000 }) {
    const stateDir = mkdtempSync(join(tmpdir(), "authoring-state-"));
    const [command, ...args] = side === "telo" ? [...teloCommand(), "run", "telo.yaml"] : ["npm", "start", "--silent"];
    const child = spawn(command, args, {
      cwd: workspace,
      env: { ...process.env, PORT: String(port), STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "pipe"],
      detached: !windows,
      shell: windows,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    const stop = async () => {
      if (child.exitCode === null) {
        try {
          process.kill(windows ? child.pid : -child.pid, "SIGTERM");
        } catch {
          // already gone
        }
        await new Promise((resolve) => {
          const force = setTimeout(() => {
            try {
              process.kill(windows ? child.pid : -child.pid, "SIGKILL");
            } catch {
              // already gone
            }
          }, 10_000);
          child.on("exit", () => {
            clearTimeout(force);
            resolve();
          });
          if (child.exitCode !== null) resolve();
        });
      }
      rmSync(stateDir, { recursive: true, force: true });
    };
    try {
      await waitForPing(port, child, readyTimeoutMs);
    } catch (error) {
      await stop();
      throw new Error(`${error.message}${stderr ? `\nlast stderr: ${stderr}` : ""}`);
    }
    return { stop };
  },
};

export async function runContract(manifest, baseUrl, timeoutMs = 10 * 60_000) {
  const [command, ...args] = teloCommand();
  const run = runToEnd(command, [...args, "run", manifest], {
    cwd: repoRoot,
    env: { ...process.env, BASE_URL: baseUrl },
    timeout: timeoutMs,
  });
  return { passed: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

export function checkContract(manifest) {
  const [command, ...args] = teloCommand();
  const run = runToEnd(command, [...args, "check", manifest], { cwd: repoRoot });
  return { passed: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

// The contract tests run with the CLI under test over this checkout's modules: one that CLI cannot
// read would fail every attempt, which is a setup fault and not an agent's failure.
export function assertContractsReadable(tasks, check = checkContract) {
  for (const task of tasks) {
    const result = check(TASKS[task].contract);
    if (!result.passed) throw new Error(`the contract tests of ${task} do not check with the CLI under test:\n${result.output}`);
  }
}
