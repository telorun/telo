import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

import type {
  AvailabilityReport,
  BackendAppSpec,
  BackendSession,
  BackendStartSpec,
  DebugFrame,
  RunBundle,
  RunnerBackend,
  RunnerEndpoint,
  RunStatus,
} from "@telorun/runner-core";
import {
  portKey,
  portsResolvedFrom,
  relayDebugStream,
  SessionStartError,
  watchReachability,
  workspaceMarkerWrite,
} from "@telorun/runner-core";

import { selfCommand } from "./self-invocation.js";
import { WorkspaceDirectory } from "./workspace-directory.js";

/**
 * The local-process `RunnerBackend`: every application in a session is a
 * `telo run` of this same executable, on this machine, as this user.
 *
 * It is the third backend behind one `/v1` contract, and the substrate it owns
 * is the `telo` binary itself — which is why it lives in the CLI rather than in
 * the backend-neutral package, exactly as the docker backend lives in the image
 * that fronts a docker socket.
 *
 * Three things are genuinely different here, and each is advertised rather than
 * hidden:
 *
 *  - **No PTY.** Node has no terminal to hand a child, so every session runs
 *    `io: "streams"`. The runner advertises only that mode and the session route
 *    refuses an explicit `tty` — `isatty()` is observable to the application, so
 *    a silent downgrade hands it a terminal it can detect it does not have.
 *  - **No isolation.** The workload inherits this process's environment and runs
 *    with its privileges. That is the point of a local run, and it is why the
 *    runner binds loopback and refuses anything else without an explicit opt-in.
 *  - **Ports are bound directly.** There is nothing to publish: an application
 *    binds the port it declares, on this host. A port that appears on reload is
 *    therefore reachable the moment something binds it, with no session to
 *    restart — the case a host-publishing docker session has to refuse.
 */

export interface ProcessBackendDeps {
  /** This runner's own directory (`prepareStateRoot`), private to the user and
   *  reclaimed by the next runner if this process is killed. One subdirectory
   *  per session, removed when the session stops.
   *
   *  There is deliberately no wall-clock ceiling for a watch session here: a
   *  developer's own machine has no operator to protect it from, and a session
   *  that dies mid-edit at a fixed hour is a defect rather than a policy. */
  stateRoot: string;
}

/** The inspect endpoint of the first app; later apps take the next ports up.
 *  Only ever dialled from this process, on loopback. */
const INSPECT_PORT_BASE = 9230;

export function createProcessBackend(deps: ProcessBackendDeps): RunnerBackend {
  return {
    async probe(): Promise<AvailabilityReport> {
      // Two things have to hold before a session can run: this CLI must know
      // how to re-invoke itself, and the state root must be writable. Both are
      // reported as what they are rather than discovered at start.
      try {
        selfCommand(["--version"]);
      } catch (err) {
        return {
          status: "unavailable",
          message: message(err),
          remediation: "Run the runner from an installed `telo`, or from the CLI's own entry point.",
        };
      }
      try {
        await fs.mkdir(deps.stateRoot, { recursive: true, mode: 0o700 });
        await fs.access(deps.stateRoot);
      } catch (err) {
        return {
          status: "unavailable",
          message: `The runner's state directory '${deps.stateRoot}' is not writable: ${message(err)}.`,
          remediation: "Set --state-dir to a directory this user can write.",
        };
      }
      return { status: "ready" };
    },

    async start(spec: BackendStartSpec): Promise<BackendSession> {
      if (spec.selfContained) {
        // `selfContained` means "the operator's catalog image carries the app",
        // and this backend has no images. The local runner advertises no app
        // catalog, so nothing can reach here — said out loud rather than left
        // to fail as a missing entry path.
        throw new SessionStartError(
          "start_failed",
          "create",
          "this runner has no application catalog: it runs manifests, not images",
        );
      }
      return spec.mode === "watch"
        ? startWatchSession(deps, spec)
        : startRunSession(deps, spec);
    },
  };
}

// --- one run ----------------------------------------------------------------

async function startRunSession(
  deps: ProcessBackendDeps,
  spec: BackendStartSpec,
): Promise<BackendSession> {
  const workspaceDir = await stageWorkspace(deps.stateRoot, spec.sessionId, spec.bundle);
  const app = spec.apps[0]!;
  const abort = new AbortController();

  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const settle = (status: RunStatus): void => {
    if (settled) return;
    settled = true;
    spec.onStatus(status);
    resolveDone();
  };

  spec.onProgress("boot", "Starting the application", undefined, app.name);
  const inspectPort = spec.inspect ? await freeLoopbackPort() : undefined;
  const child = spawnApp({
    workspaceDir,
    app,
    env: spec.env,
    watch: false,
    inspectPort,
    onOutput: spec.onOutput,
  });

  spec.onStatus({ kind: "running", endpoints: endpointsFor([app]) });
  if (inspectPort !== undefined) {
    void relayDebugStream({
      url: inspectUrl(inspectPort),
      onFrame: (frame) => spec.onDebug(app.name, frame),
      signal: abort.signal,
    });
  }
  watchPorts(app, abort.signal, spec);

  child.on("error", (err) => {
    abort.abort();
    settle({ kind: "failed", message: `could not start telo: ${err.message}` });
    void removeDir(sessionDir(deps.stateRoot, spec.sessionId));
  });
  child.on("exit", (code, signal) => {
    abort.abort();
    // A run session IS its run, so the process ending ends the session. A kill
    // the user asked for is `stopped`; anything else reports the code it
    // really exited with, including a signal that killed it.
    if (spec.isUserStopped()) settle({ kind: "stopped" });
    else if (signal) settle({ kind: "failed", message: `the application was killed by ${signal}` });
    else settle({ kind: "exited", code: code ?? 0 });
    void removeDir(sessionDir(deps.stateRoot, spec.sessionId));
  });

  return {
    writeStdin(_app, bytes) {
      writeStdin(child, bytes);
    },
    resize() {
      // No PTY: the route rejects a resize under `io: "streams"` before it
      // reaches here.
    },
    done,
    async stop() {
      abort.abort();
      await killTree(child);
    },
  };
}

// --- a watched workspace -----------------------------------------------------

async function startWatchSession(
  deps: ProcessBackendDeps,
  spec: BackendStartSpec,
): Promise<BackendSession> {
  const workspaceDir = await stageWorkspace(deps.stateRoot, spec.sessionId, spec.bundle);
  const workspace = new WorkspaceDirectory(workspaceDir);

  let apps = spec.apps;
  const children = new Map<string, ChildProcess>();
  let abort = new AbortController();
  // A process going away because WE took it down — a stop, a suspend, or a
  // change to the app set — is not a run failing. Without this the teardown is
  // reported as `run.failed`, a defect the user is then asked to explain.
  let teardownInProgress = false;

  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const settle = (status: RunStatus): void => {
    if (settled) return;
    settled = true;
    spec.onStatus(status);
    resolveDone();
  };

  await startApps();
  spec.onStatus({ kind: "running", endpoints: endpointsFor(apps) });

  return {
    writeStdin(app, bytes) {
      const child = children.get(app);
      if (child) writeStdin(child, bytes);
    },
    resize() {
      /* no PTY — see `resize` on a run session */
    },
    done,
    get workspace() {
      return workspace;
    },
    async reload(app) {
      const target = apps.find((a) => a.name === app);
      if (!target) return;
      await workspace.touch(target.entryRelativePath);
    },
    async setApps(next) {
      teardownInProgress = true;
      await stopChildren();
      teardownInProgress = false;
      apps = next;
      abort = new AbortController();
      await startApps();
      spec.onStatus({ kind: "running", endpoints: endpointsFor(apps) });
    },
    async suspend() {
      teardownInProgress = true;
      await stopAll();
      // The workspace lives on in the checkpoint core already holds; the
      // directory is rebuilt from it when the session resumes.
      await removeDir(sessionDir(deps.stateRoot, spec.sessionId));
    },
    async stop() {
      teardownInProgress = true;
      await stopAll();
      await removeDir(sessionDir(deps.stateRoot, spec.sessionId));
      settle({ kind: "stopped" });
    },
  };

  async function startApps(): Promise<void> {
    for (const [index, app] of apps.entries()) {
      spec.onProgress("boot", "Starting the application", undefined, app.name);
      const inspectPort = await freeLoopbackPort(INSPECT_PORT_BASE + index);
      const child = spawnApp({
        workspaceDir,
        app,
        env: spec.env,
        watch: true,
        inspectPort,
        onOutput: spec.onOutput,
      });
      children.set(app.name, child);

      const signal = abort.signal;
      void relayDebugStream({
        url: inspectUrl(inspectPort),
        onFrame: (frame) => {
          applyPortsResolved(app.name, frame, signal);
          spec.onDebug(app.name, frame);
        },
        signal,
      });
      watchPorts(app, signal, spec);

      child.on("error", (err) => {
        if (teardownInProgress) return;
        spec.onRunEnded(app.name, { reason: `could not start telo: ${err.message}` });
      });
      child.on("exit", (code, exitSignal) => {
        // Under `--watch` a finished run leaves the process up, so a process
        // that goes away has died. Reported through the contract rather than by
        // synthesizing a kernel frame: that stream carries frames the workload
        // produced.
        if (teardownInProgress) return;
        children.delete(app.name);
        spec.onRunEnded(app.name, {
          code: code ?? undefined,
          reason: exitSignal
            ? `the application was killed by ${exitSignal}`
            : `the application exited (code ${code ?? "unknown"})`,
        });
      });
    }
  }

  /**
   * Re-publish an app whose declared port set changed on reload.
   *
   * The kernel re-resolves its `ports:` block on every load and says so on the
   * stream the runner already reads, so nothing here parses a manifest. Locally
   * there is nothing to publish — the application binds the port itself — so a
   * newly declared port is reachable as soon as something binds it, and this
   * only has to say so and start watching it. A port another app in the session
   * already declares is still refused: two processes cannot bind one port, and
   * reporting it beats letting the second fail with `EADDRINUSE` on a stream
   * nobody connects to the cause.
   */
  function applyPortsResolved(appName: string, frame: DebugFrame, signal: AbortSignal): void {
    const declared = portsResolvedFrom(frame);
    if (!declared) return;
    const app = apps.find((a) => a.name === appName);
    if (!app) return;

    const before = new Map(app.ports.map((p) => [portKey(p), p]));
    const after = new Map(declared.map((p) => [portKey(p), p]));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    if (added.length === 0 && removed.length === 0) return;

    const taken = new Set(
      apps.filter((a) => a.name !== appName).flatMap((a) => a.ports.map(portKey)),
    );
    const conflicting = added.filter((p) => taken.has(portKey(p)));
    const routable = added.filter((p) => !taken.has(portKey(p)));

    app.ports = [...app.ports.filter((p) => after.has(portKey(p))), ...routable];

    spec.onEndpoints(appName, {
      ...(routable.length > 0 ? { added: endpointsFor([{ ...app, ports: routable }]) } : {}),
      ...(removed.length > 0 ? { removed: endpointsFor([{ ...app, ports: removed }]) } : {}),
      ...(conflicting.length > 0
        ? {
            rejected: conflicting.map((p) => ({
              port: p.port,
              reason: `another app in this session already declares ${p.protocol} port ${p.port}`,
            })),
          }
        : {}),
    });

    watchPorts({ ...app, ports: routable }, signal, spec);
  }

  async function stopChildren(): Promise<void> {
    abort.abort();
    const running = [...children.values()];
    children.clear();
    await Promise.all(running.map((child) => killTree(child)));
  }

  async function stopAll(): Promise<void> {
    await stopChildren();
  }
}

// --- process plumbing --------------------------------------------------------

interface SpawnAppArgs {
  workspaceDir: string;
  app: BackendAppSpec;
  env: Record<string, string>;
  watch: boolean;
  inspectPort?: number;
  onOutput: BackendStartSpec["onOutput"];
}

/**
 * One application process: `telo run <entry>` of THIS telo, in the session's
 * workspace.
 *
 * `detached` on POSIX puts it in its own process group, which is what makes a
 * stop reach the whole tree — the kernel's own children (a controller's build,
 * a spawned tool) outlive a kill aimed at the parent alone, and a leaked
 * `telo run --watch` holding a port after the editor quits is the failure this
 * prevents. Windows has no process groups; `killTree` uses `taskkill /T` there.
 */
function spawnApp(args: SpawnAppArgs): ChildProcess {
  const entry = path.join(args.workspaceDir, args.app.entryRelativePath);
  // `telo run`'s own options precede the path: everything after it is the
  // application's.
  const teloArgs = ["run"];
  if (args.watch) teloArgs.push("--watch");
  if (args.inspectPort !== undefined) {
    // Loopback only, and never published: this endpoint is the runner's own
    // window onto the kernel, and `--no-open` keeps it from launching a browser
    // on the user's desktop for a session they are already watching.
    teloArgs.push("--inspect", `127.0.0.1:${args.inspectPort}`, "--no-open");
  }
  teloArgs.push(entry);

  const { command, args: argv } = selfCommand(teloArgs);
  const child = spawn(command, argv, {
    cwd: args.workspaceDir,
    // The workload inherits this process's environment: a local run's whole
    // point is the machine it runs on (PATH, HOME, certificates), and the
    // session's own env wins over it.
    env: { ...process.env, ...args.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => args.onOutput(args.app.name, chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => args.onOutput(args.app.name, chunk, "stderr"));
  return child;
}

function writeStdin(child: ChildProcess, bytes: Uint8Array): void {
  try {
    child.stdin?.write(Buffer.from(bytes));
  } catch {
    /* the process ended; a write to a dead workload is a no-op by contract */
  }
}

/** Stop a workload and everything it started, then wait for it to be gone.
 *  SIGTERM first so the kernel runs its teardown (a held port is released, a
 *  database connection closed), SIGKILL only for what ignores it. */
async function killTree(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  signalTree(child, "SIGTERM");
  const timer = setTimeout(() => signalTree(child, "SIGKILL"), graceMs);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // No process groups: taskkill walks the tree by pid.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    // Negative pid = the process GROUP `detached` gave it.
    process.kill(-child.pid, signal);
  } catch {
    // Already gone, or the group was never created — fall back to the process
    // itself rather than leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

// --- session files -----------------------------------------------------------

function sessionDir(stateRoot: string, sessionId: string): string {
  return path.join(stateRoot, sessionId);
}

/**
 * Write the bundle into this session's own directory, plus the workspace-root
 * marker — which is what anchors ONE module cache for every app in the session
 * instead of one per entry directory.
 */
async function stageWorkspace(
  stateRoot: string,
  sessionId: string,
  bundle: RunBundle,
): Promise<string> {
  const dir = path.join(sessionDir(stateRoot, sessionId), "workspace");
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const workspace = new WorkspaceDirectory(dir);
    await workspace.apply({
      write: [
        ...bundle.files.map((f) => ({
          path: f.relativePath,
          content: f.contents,
          encoding: f.encoding ?? ("utf8" as const),
        })),
        ...workspaceMarkerWrite(bundle),
      ],
    });
  } catch (err) {
    throw new SessionStartError(
      "start_failed",
      "create",
      `could not stage the session workspace at ${dir}`,
      message(err),
    );
  }
  return dir;
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {
    /* best-effort: the session is over either way */
  });
}

// --- endpoints ---------------------------------------------------------------

/** A local application binds its own port on this host, so there is no mapping
 *  to report — `host` is empty and the client fills it from the base URL it
 *  reached the runner on, which is the same machine by construction. */
function endpointsFor(apps: BackendAppSpec[]): RunnerEndpoint[] {
  return apps.flatMap((app) =>
    app.ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol })),
  );
}

function watchPorts(app: BackendAppSpec, signal: AbortSignal, spec: BackendStartSpec): void {
  const tcp = app.ports.filter((p) => p.protocol === "tcp").map((p) => p.port);
  if (tcp.length === 0) return;
  void watchReachability({
    host: "127.0.0.1",
    ports: tcp,
    onState: (port, state) => spec.onReachability(app.name, port, state),
    signal,
  });
}

function inspectUrl(port: number): string {
  return `http://127.0.0.1:${port}/events`;
}

/**
 * A free loopback port, preferring one if it is available.
 *
 * Mildly racy — nothing holds it between this check and the child binding it —
 * which is why a preference is only a preference: two watch sessions started at
 * once would otherwise both take 9230 and the second would die on its inspect
 * endpoint rather than on anything the user did.
 */
async function freeLoopbackPort(preferred?: number): Promise<number> {
  if (preferred !== undefined && (await portIsFree(preferred))) return preferred;
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free loopback port"))));
    });
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
