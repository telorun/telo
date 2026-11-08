// Builds the Node implementation, starts it on a fresh state directory and runs the contract
// tests against it with `telo run`, then stops it. Exits with the contract run's exit code.
//   TELO_COMMAND  the command that runs telo, default: the checkout's own CLI under bun
//   PORT          the port the implementation listens on, default 8872
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const port = process.env.PORT ?? "8872";
const windows = process.platform === "win32";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const build = spawnSync(process.execPath, [tsc, "-p", join(here, "tsconfig.json")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const teloCommand = process.env.TELO_COMMAND
  ? process.env.TELO_COMMAND.split(" ")
  : [join(root, "node_modules", ".bin", windows ? "bun.cmd" : "bun"), join(root, "cli/nodejs/bin/telo.ts")];

const stateDir = mkdtempSync(join(tmpdir(), "lead-intake-"));
const server = spawn(process.execPath, [join(here, "dist/server.js")], {
  cwd: here,
  env: { ...process.env, PORT: port, STATE_DIR: stateDir },
  stdio: ["ignore", "inherit", "inherit"],
});
let serverExited = false;
server.on("exit", () => (serverExited = true));

async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverExited) throw new Error("the implementation exited before it answered");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the implementation did not answer /ping within 10s");
}

let status = 1;
try {
  await ready();
  const [command, ...args] = teloCommand;
  const run = spawnSync(command, [...args, "run", join(root, "benchmarks/lead-intake/contract/run.yaml")], {
    stdio: "inherit",
    shell: windows,
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
  });
  status = run.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  server.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
process.exit(status);
