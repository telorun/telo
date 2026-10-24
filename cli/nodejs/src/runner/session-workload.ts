import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

import type {
  AppAddresses,
  AppRun,
  BackendAppSpec,
  BackendWorkload,
  PortMapping,
  ResolvedRunnerApp,
  RunnerEndpoint,
  WorkloadCallbacks,
  WorkloadSpec,
} from "@telorun/runner-core";
import {
  AppRunRefused,
  portKey,
  SessionStartError,
  WORKSPACE_MARKER_CONTENTS,
  WORKSPACE_MARKER_FILENAME,
} from "@telorun/runner-core";

import { hasExited, spawnAppProcess, spawned, stopAppProcess } from "./app-process.js";
import type { SelfInvocation } from "./self-invocation.js";
import { createSessionDirectory, type SessionDirectory } from "./state-root.js";
import { TeloVersionUnavailable, type TeloSupply } from "./telo-supply.js";
import { WorkspaceDirectory } from "./workspace-directory.js";

/**
 * A local session's workload: its directory and, while Run has started one,
 * one `telo run` process per application. A slot is "ready" by existing —
 * there is no container to stand up — so creating a workload is creating the
 * directory and getting each app's telo.
 */

/** The inspect endpoint the first app prefers; later apps prefer the next
 *  ports up. Only ever dialled from this process, on loopback. */
const INSPECT_PORT_BASE = 9230;

/** How long suspend and shutdown wait for a run's teardown before SIGKILL —
 *  below the five seconds the desktop shell waits for the runner itself. */
const WORKLOAD_END_GRACE_MS = 3_000;

export interface SessionWorkloadDeps {
  stateRoot: string;
  telo: TeloSupply;
  /** How this telo is invoked, for an app naming no version. */
  self(): Promise<SelfInvocation>;
}

interface LiveRun {
  runId: string;
  child: ChildProcess;
  /** Settles once the spawn did or did not happen; runApp reports a failure. */
  started: Promise<void>;
  /** Settles once the process is gone and its ending was reported. */
  ended: Promise<void>;
}

interface AppSlot {
  app: BackendAppSpec;
  telo: SelfInvocation;
  run?: LiveRun;
}

export class LocalSessionWorkload implements BackendWorkload {
  private slots = new Map<string, AppSlot>();
  /** Set once the workload is suspended or detached: an ending after that is
   *  core's to report, not this workload's. */
  private closed = false;

  private constructor(
    private readonly deps: SessionWorkloadDeps,
    private readonly callbacks: WorkloadCallbacks,
    private readonly directory: SessionDirectory,
    readonly workspace: WorkspaceDirectory,
  ) {}

  static async create(
    deps: SessionWorkloadDeps,
    spec: WorkloadSpec,
    callbacks: WorkloadCallbacks,
  ): Promise<LocalSessionWorkload> {
    refuseAgent(spec.agent);
    let directory: SessionDirectory;
    try {
      directory = await createSessionDirectory(deps.stateRoot, spec.sessionId);
      await seedWorkspaceMarker(directory.workspace);
    } catch (err) {
      throw new SessionStartError(
        "start_failed",
        "create",
        `could not prepare the session directory under ${deps.stateRoot}`,
        messageOf(err),
      );
    }
    const workload = new LocalSessionWorkload(
      deps,
      callbacks,
      directory,
      new WorkspaceDirectory(directory.workspace),
    );
    workload.slots = await workload.slotsFor(spec.apps);
    workload.reportRunning();
    return workload;
  }

  async addresses(app: string): Promise<AppAddresses> {
    const index = [...this.slots.keys()].indexOf(app);
    const port = await freeLoopbackPort(index >= 0 ? INSPECT_PORT_BASE + index : undefined);
    return {
      inspect: { listen: `127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/events` },
      host: "127.0.0.1",
    };
  }

  async runApp(appName: string, run: AppRun): Promise<void> {
    const slot = this.slotOf(appName);
    if (slot.run) {
      if (slot.run.runId === run.runId) return;
      throw new AppRunRefused("run_active", `app '${appName}' already has a live run`);
    }
    if (this.closed) throw new Error("the session's workload has ended");

    const child = spawnAppProcess({
      telo: slot.telo,
      argv: run.argv,
      cwd: this.workspaceDirectory(run.cwd),
      env: run.env,
    });
    let reportEnding!: () => void;
    const live: LiveRun = {
      runId: run.runId,
      child,
      started: spawned(child),
      ended: new Promise<void>((resolve) => (reportEnding = resolve)),
    };
    slot.run = live;
    try {
      await live.started;
    } catch (err) {
      slot.run = undefined;
      reportEnding();
      throw new Error(`could not start telo: ${messageOf(err)}`);
    }

    child.on("error", (err) =>
      this.callbacks.onOutput(appName, Buffer.from(`[runner] ${err.message}\n`), "stderr"),
    );
    child.stdout?.on("data", (chunk: Buffer) => this.callbacks.onOutput(appName, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => this.callbacks.onOutput(appName, chunk, "stderr"));
    // A write racing the process's exit fails on a closed pipe, and input for
    // a run that ended is dropped by contract. Any other failure is the run's
    // to show, on its own stderr.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
      this.callbacks.onOutput(
        appName,
        Buffer.from(`[runner] writing to the application's stdin failed: ${err.message}\n`),
        "stderr",
      );
    });
    child.once("exit", (code, signal) => {
      if (slot.run === live) slot.run = undefined;
      if (!this.closed) {
        this.callbacks.onAppState(appName, {
          state: "ready",
          ended: { runId: run.runId, ...(signal ? { signal } : { code: code ?? 0 }) },
        });
      }
      reportEnding();
    });
    this.callbacks.onAppState(appName, { state: "running", runId: run.runId });
  }

  async stopApp(appName: string, runId: string, graceMs: number): Promise<void> {
    const live = this.slots.get(appName)?.run;
    if (!live || live.runId !== runId) return;
    // Asked, not awaited: the ending is reported when the process is gone.
    void live.started.then(
      () => stopAppProcess(live.child, graceMs),
      () => undefined,
    );
  }

  writeStdin(appName: string, runId: string, bytes: Uint8Array): void {
    const live = this.slots.get(appName)?.run;
    if (!live || live.runId !== runId || hasExited(live.child)) return;
    live.child.stdin?.write(Buffer.from(bytes));
  }

  resize(): void {
    // No pty: every run is `io: "streams"`, which core never resizes.
  }

  async reload(appName: string): Promise<void> {
    await this.workspace.touch(this.slotOf(appName).app.entryRelativePath);
  }

  /**
   * An app's kernel announced its declared ports. Locally there is nothing to
   * publish — the application binds the port itself — so a newly declared port
   * is reachable as soon as something binds it, and this only has to say so. A
   * port another app of the session already declares is refused: two processes
   * cannot bind one port, and reporting it beats letting the second fail with
   * `EADDRINUSE` on a stream nobody connects to the cause.
   */
  applyDeclaredPorts(appName: string, declared: PortMapping[]): void {
    const slot = this.slots.get(appName);
    if (!slot) return;
    const app = slot.app;
    const before = new Set(app.ports.map(portKey));
    const after = new Set(declared.map(portKey));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    if (added.length === 0 && removed.length === 0) return;

    const taken = new Set(
      [...this.slots.values()].filter((s) => s !== slot).flatMap((s) => s.app.ports.map(portKey)),
    );
    const conflicting = added.filter((p) => taken.has(portKey(p)));
    const routable = added.filter((p) => !taken.has(portKey(p)));
    slot.app = { ...app, ports: [...app.ports.filter((p) => after.has(portKey(p))), ...routable] };

    this.callbacks.onEndpoints(appName, {
      ...(routable.length > 0 ? { added: endpointsFor(routable) } : {}),
      ...(removed.length > 0 ? { removed: endpointsFor(removed) } : {}),
      ...(conflicting.length > 0
        ? {
            rejected: conflicting.map((p) => ({
              port: p.port,
              reason: `another app in this session already declares ${p.protocol} port ${p.port}`,
            })),
          }
        : {}),
    });
  }

  /** Every live run ends; the new set's slots are ready once each has its telo. */
  async setApps(apps: BackendAppSpec[]): Promise<void> {
    await this.endRuns(WORKLOAD_END_GRACE_MS);
    this.slots = await this.slotsFor(apps);
    this.reportRunning();
  }

  async setAgent(agent: ResolvedRunnerApp | undefined): Promise<void> {
    refuseAgent(agent);
  }

  async suspend(): Promise<void> {
    this.closed = true;
    await this.endRuns(WORKLOAD_END_GRACE_MS);
  }

  /** A local workload never outlives the runner: its runs end with it, and the
   *  directory stays for the next runner to resume. */
  async detach(): Promise<void> {
    await this.suspend();
  }

  // ---- internals ------------------------------------------------------------

  private async endRuns(graceMs: number): Promise<void> {
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        const live = slot.run;
        if (!live) return;
        // A spawn still in flight is stopped once it happened; one that never
        // happened is runApp's failure to report, and has nothing to stop.
        await live.started.then(
          () => stopAppProcess(live.child, graceMs),
          () => undefined,
        );
        await live.ended;
      }),
    );
  }

  private async slotsFor(apps: BackendAppSpec[]): Promise<Map<string, AppSlot>> {
    const slots = new Map<string, AppSlot>();
    for (const app of apps) {
      slots.set(app.name, { app: { ...app, ports: [...app.ports] }, telo: await this.teloFor(app) });
    }
    return slots;
  }

  /** The telo an app runs on: the one it names, or this one. A release not
   *  held yet is downloaded here, reported on the session's stream. */
  private async teloFor(app: BackendAppSpec): Promise<SelfInvocation> {
    try {
      if (app.telo === undefined) return await this.deps.self();
      return await this.deps.telo.invocation(app.telo, () =>
        this.callbacks.onProgress("provision", `Downloading telo ${app.telo}`, undefined, app.name),
      );
    } catch (err) {
      if (err instanceof TeloVersionUnavailable || app.telo === undefined) {
        throw new SessionStartError("start_failed", "create", messageOf(err));
      }
      throw err;
    }
  }

  private reportRunning(): void {
    this.callbacks.onStatus({
      kind: "running",
      endpoints: endpointsFor([...this.slots.values()].flatMap((s) => s.app.ports)),
    });
    for (const name of this.slots.keys()) this.callbacks.onAppState(name, { state: "ready" });
  }

  private slotOf(appName: string): AppSlot {
    const slot = this.slots.get(appName);
    if (!slot) throw new Error(`app '${appName}' is not in this session`);
    return slot;
  }

  /** A run's workspace-relative cwd, held inside the workspace. */
  private workspaceDirectory(relative: string): string {
    const root = this.directory.workspace;
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`the run's working directory '${relative}' leaves the session workspace`);
    }
    return resolved;
  }
}

/** This runner offers no co-resident agent (`features.agents` is empty), so
 *  core never hands one over; one arriving anyway is refused, not ignored. */
function refuseAgent(agent: ResolvedRunnerApp | undefined): void {
  if (agent) {
    throw new SessionStartError(
      "start_failed",
      "create",
      `this runner runs no co-resident agent, and '${agent.name}' was asked for`,
    );
  }
}

/** The marker that anchors one module cache for every app in the session,
 *  written once; a workspace that carries its own keeps it. */
async function seedWorkspaceMarker(workspace: string): Promise<void> {
  const marker = path.join(workspace, WORKSPACE_MARKER_FILENAME);
  try {
    await fs.writeFile(marker, WORKSPACE_MARKER_CONTENTS, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** A local application binds its own port on this host, so there is no mapping
 *  to report — `host` is empty and the client fills it from the base URL it
 *  reached the runner on, which is the same machine by construction. */
function endpointsFor(ports: PortMapping[]): RunnerEndpoint[] {
  return ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol }));
}

/**
 * A free loopback port, preferring one if it is available. Mildly racy —
 * nothing holds it between this check and the child binding it — which is why a
 * preference is only a preference.
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
