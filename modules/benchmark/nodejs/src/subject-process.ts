import { spawn, type ChildProcess } from "node:child_process";
import { Agent, request } from "undici";
import { truncate } from "./error-sample.js";
import { formatCpuList } from "./core-split.js";

const READINESS_POLL_MS = 1;
const GROUP_POLL_MS = 5;
const MAX_STDERR_LINE = 300;
const STDERR_SETTLE_MS = 1000;
const PORT_PROBE_MS = 200;

export interface SubjectLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cpus: number[];
}

/** How a boot ended before it could be measured. */
export type BootFault =
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timeout" }
  | { kind: "stopTimeout" };

export class BootFaultError extends Error {
  constructor(
    readonly fault: BootFault,
    readonly lastStderrLine: string | undefined,
  ) {
    super(fault.kind);
    this.name = "BootFaultError";
  }
}

/** Whether an HTTP server already answers `url` — before the subject started, that is another process. */
export async function answersAlready(url: string): Promise<boolean> {
  const agent = new Agent({ connections: 1 });
  try {
    return await request(url, { dispatcher: agent, signal: AbortSignal.timeout(PORT_PROBE_MS) }).then(
      async (response) => {
        await response.body.dump();
        return true;
      },
      () => false, // refused, or accepted without an HTTP answer: no server is answering it
    );
  } finally {
    await agent.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True when `ms` passed first; the timer is cleared either way so it never holds the process open.
async function timedOut(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([settled.then(() => false), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * One boot of a subject: started under `taskset` on the subject CPUs, in a process group of
 * its own so that ending it reaches every process it started.
 */
export class SubjectProcess {
  readonly startedAt: number;
  readonly pid: number;
  private readonly child: ChildProcess;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
  private readonly exited: Promise<void>;
  private readonly closed: Promise<void>;
  private stderrTail = "";
  private lastLine: string | undefined;

  constructor(launch: SubjectLaunch) {
    this.startedAt = performance.now();
    this.child = spawn("taskset", ["-c", formatCpuList(launch.cpus), launch.command, ...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (this.child.pid === undefined) throw new Error(`could not start taskset for "${launch.command}"`);
    this.pid = this.child.pid;
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal, at: performance.now() };
        resolve();
      });
    });
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.takeStderr(chunk));
  }

  private takeStderr(chunk: string): void {
    const lines = (this.stderrTail + chunk).split("\n");
    this.stderrTail = lines.pop()!.slice(-4 * MAX_STDERR_LINE);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line !== "") {
        this.lastLine = truncate(line, MAX_STDERR_LINE);
        break;
      }
    }
  }

  // A process outside the group (a daemon that left it) may hold stderr open after the group is gone.
  private async stderrSettled(): Promise<void> {
    await this.exited;
    await timedOut(this.closed, STDERR_SETTLE_MS);
  }

  /** The last non-empty line the subject wrote to stderr, once it has exited. */
  async lastStderrLine(): Promise<string | undefined> {
    await this.stderrSettled();
    const tail = this.stderrTail.trim();
    return tail !== "" ? truncate(tail, MAX_STDERR_LINE) : this.lastLine;
  }

  /** The fault of a boot that has already exited, without waiting for its stderr to close. */
  exitFault(): BootFaultError | undefined {
    if (!this.exitInfo) return undefined;
    const tail = this.stderrTail.trim();
    const line = tail !== "" ? truncate(tail, MAX_STDERR_LINE) : this.lastLine;
    return new BootFaultError({ kind: "exited", code: this.exitInfo.code, signal: this.exitInfo.signal }, line);
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  private async fault(fault: BootFault): Promise<never> {
    throw new BootFaultError(fault, await this.lastStderrLine());
  }

  /** Ms from start to the first 2xx answer at `url`; a poll in flight is dropped when the subject exits. */
  async untilReady(url: string, timeoutMs: number): Promise<number> {
    const agent = new Agent({ connections: 1 });
    const deadline = this.startedAt + timeoutMs;
    const ended = new AbortController();
    void this.exited.then(() => ended.abort());
    try {
      for (;;) {
        if (this.exitInfo) return await this.fault({ kind: "exited", ...this.exitInfo });
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          this.kill();
          await this.exited;
          return await this.fault({ kind: "timeout" });
        }
        const signal = AbortSignal.any([ended.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))]);
        const answered = await request(url, { dispatcher: agent, signal }).then(
          async (response) => {
            await response.body.dump();
            return response.statusCode >= 200 && response.statusCode < 300;
          },
          () => false, // not listening yet, reset while starting, or ended: decided above on the next turn
        );
        if (answered) return performance.now() - this.startedAt;
        await sleep(READINESS_POLL_MS);
      }
    } finally {
      ended.abort();
      await agent.destroy();
    }
  }

  /** Ms from start to exit; a non-zero exit or one past `timeoutMs` is a fault. */
  async untilExit(timeoutMs: number): Promise<number> {
    const remaining = this.startedAt + timeoutMs - performance.now();
    if ((await timedOut(this.exited, Math.max(0, remaining))) && !this.exitInfo) {
      this.kill();
      await this.exited;
      return await this.fault({ kind: "timeout" });
    }
    const info = this.exitInfo!;
    if (info.code !== 0) return await this.fault({ kind: "exited", code: info.code, signal: info.signal });
    await this.drainGroup(timeoutMs);
    return info.at - this.startedAt;
  }

  /** Ends the boot with SIGTERM to the whole group, SIGKILL after `timeoutMs`. */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.exitInfo) signalGroup(this.pid, "SIGTERM");
    await this.drainGroup(timeoutMs);
  }

  // Waits for the leader and every process left in its group to be gone; SIGKILL at the deadline.
  private async drainGroup(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    await timedOut(this.exited, timeoutMs);
    let terminated = false;
    while (!this.exitInfo || groupAlive(this.pid)) {
      if (performance.now() >= deadline) {
        this.kill();
        await this.exited;
        return await this.fault({ kind: "stopTimeout" });
      }
      if (this.exitInfo && !terminated) {
        signalGroup(this.pid, "SIGTERM"); // processes the leader left behind
        terminated = true;
      }
      await sleep(GROUP_POLL_MS);
    }
    await this.stderrSettled();
  }

  /** SIGKILL to the whole group; safe to call at any time, also from an exit handler. */
  kill(): void {
    signalGroup(this.pid, "SIGKILL");
  }
}
