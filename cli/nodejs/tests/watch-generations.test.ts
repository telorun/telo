import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * `telo run --watch` takes no hold of its own: each generation runs as a plain
 * run would, so a one-shot app is torn down when it finishes and reports its
 * exit code, while the session stays up for the next edit; a Service holds the
 * kernel itself and keeps serving.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../bin/telo.ts");
const MODULES = path.resolve(HERE, "../../../modules");

let scratch: string;
let child: ChildProcess | undefined;

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-watch-")));
  fs.writeFileSync(path.join(scratch, "debug-ui.html"), "<html></html>");
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child!.once("exit", resolve));
  }
  child = undefined;
});

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function appDir(name: string, manifest: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "telo.yaml"), manifest);
  return dir;
}

const moduleSource = (dir: string, name: string) =>
  path.relative(dir, path.join(MODULES, name)).split(path.sep).join("/");

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function watch(dir: string, env: Record<string, string> = {}): Promise<ChildProcess> {
  const inspect = await freePort();
  child = spawn(
    "bun",
    [CLI, "run", "--watch", "--debug", `--inspect=127.0.0.1:${inspect}`, "--no-open", "--no-input", "telo.yaml"],
    {
      cwd: dir,
      env: {
        ...process.env,
        ...env,
        TELO_CACHE_DIR: path.join(scratch, "cache"),
        TELO_DEBUG_UI_PATH: path.join(scratch, "debug-ui.html"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  return child;
}

type Frame = { kind: string; event?: string; payload?: any; line?: string };

function frames(dir: string): Frame[] {
  const file = path.join(dir, ".telo.debug.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Frame);
}

const events = (dir: string, name: string) => frames(dir).filter((f) => f.kind === "event" && f.event === name);

async function until(what: string, done: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

// On Windows `bun` is a `.cmd` shim, reachable only through cmd.exe, which a
// long-lived watched process killed by the test cannot be spawned through.
describe.skipIf(process.platform === "win32")("telo run --watch", () => {
  it("ends a one-shot generation with its exit code, stays up, and starts the next on an edit", async () => {
    const dir = path.join(scratch, "one-shot");
    const manifest = (word: string) => `kind: Telo.Application
metadata:
  name: WatchOneShot
imports:
  Console: ${moduleSource(dir, "console")}
  Run: ${moduleSource(dir, "run")}
targets:
  - !ref main
---
kind: Run.Sequence
metadata:
  name: main
steps:
  - name: say
    invoke:
      kind: Console.WriteLine
    inputs:
      output: ${word}
`;
    appDir("one-shot", manifest("generation-one"));
    const session = await watch(dir);

    await until("the first generation to stop", () => events(dir, "Kernel.Stopped").length === 1);
    expect(events(dir, "Kernel.Stopped")[0]!.payload).toEqual({ exitCode: 0 });
    expect(events(dir, "Kernel.Stopping")).toHaveLength(1);
    await settle();
    expect(session.exitCode).toBeNull();
    expect(session.signalCode).toBeNull();
    expect(events(dir, "Kernel.Starting")).toHaveLength(1);

    fs.writeFileSync(path.join(dir, "telo.yaml"), manifest("generation-two"));
    await until("the second generation to stop", () => events(dir, "Kernel.Stopped").length === 2);
    expect(events(dir, "Kernel.Starting")).toHaveLength(2);
    expect(frames(dir).some((f) => f.kind === "log" && f.line?.includes("generation-two"))).toBe(true);
    expect(session.exitCode).toBeNull();
  }, 180_000);

  it("keeps a Service serving, since the Service holds the kernel itself", async () => {
    const dir = path.join(scratch, "service");
    appDir(
      "service",
      `kind: Telo.Application
metadata:
  name: WatchService
imports:
  Http: ${moduleSource(dir, "http-server")}
  Run: ${moduleSource(dir, "run")}
targets:
  - !ref server
ports:
  http:
    env: PORT
    protocol: tcp
---
kind: Http.Server
metadata:
  name: server
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref api
---
kind: Http.Api
metadata:
  name: api
routes:
  - request:
      path: /ping
      method: GET
    handler:
      kind: Run.Value
      value:
        message: pong
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              properties:
                message: { type: string }
              required: [message]
            body:
              message: !cel "result.message"
`,
    );
    const port = await freePort();
    await watch(dir, { PORT: String(port) });

    await until("the server to start", () => events(dir, "Kernel.Started").length === 1);
    await settle();
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "pong" });
    expect(events(dir, "Kernel.Stopped")).toHaveLength(0);
  }, 180_000);
});
