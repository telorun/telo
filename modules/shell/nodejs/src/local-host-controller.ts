import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  BufferedResult,
  ExecutionHandle,
  RunOptions,
  ShellHost,
  StreamPart,
} from "./shell-host.js";

interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdin?: string;
  command: string;
}

interface LocalHostManifest {
  metadata: { name: string; module: string };
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
}

/** Filter the kernel-sanctioned host env (`ctx.env`) down to defined entries. */
function toEnvRecord(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function defaultShell(hostEnv: Record<string, string>): string {
  if (process.platform === "win32") return hostEnv.ComSpec ?? "cmd.exe";
  return "/bin/sh";
}

function shellInvocation(shell: string, command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: shell, args: ["/d", "/s", "/c", command] };
  return { file: shell, args: ["-c", command] };
}

/** Spawn the shell as its own process-group leader (POSIX) so the whole tree
 *  can be torn down together. Without this, killing the shell orphans any
 *  grandchild it spawned (a `sleep`, a dev server), which also keeps the stdout
 *  pipe open so `close` never fires. */
function spawnChild(spec: SpawnSpec): ChildProcess {
  return spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: process.platform !== "win32",
  });
}

/** Kill the child's entire process group (POSIX) / process (Windows). No-op if
 *  it has already exited. */
function killChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH — the process group is already gone.
  }
}

function writeStdin(child: ChildProcess, stdin?: string): void {
  if (!child.stdin) return;
  // A child that doesn't read stdin (or exits early) makes writes/`end()` emit
  // EPIPE on the writable; with no listener Node escalates to an
  // uncaughtException and tears the kernel down. EPIPE here is benign — the
  // command's outcome is decided by its exit code — so absorb stdin errors.
  child.stdin.on("error", () => {});
  if (stdin !== undefined) child.stdin.write(stdin);
  child.stdin.end();
}

function spawnError(err: NodeJS.ErrnoException, spec: SpawnSpec): Error {
  if (err.code === "ENOENT") return new Error(`Shell: interpreter not found: ${spec.file}`);
  return new Error(`Shell: failed to run command (${err.code ?? err.message}): ${spec.command}`);
}

function runBuffered(spec: SpawnSpec): Promise<BufferedResult> {
  return new Promise<BufferedResult>((resolve, reject) => {
    const child = spawnChild(spec);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killChild(child);
        }, spec.timeoutMs)
      : undefined;
    timer?.unref?.();
    const onAbort = () => {
      cancelled = true;
      killChild(child);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(spawnError(err, spec));
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (timedOut) {
        reject(new Error(`Shell command timed out after ${spec.timeoutMs}ms: ${spec.command}`));
        return;
      }
      if (cancelled) {
        reject(new Error(`Shell command cancelled: ${spec.command}`));
        return;
      }
      if (signal) {
        reject(new Error(`Shell command terminated by signal ${signal}: ${spec.command}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    writeStdin(child, spec.stdin);
  });
}

function runStream(spec: SpawnSpec): AsyncIterable<StreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      const child = spawnChild(spec);
      const queue: StreamPart[] = [];
      let finished = false;
      let wake: (() => void) | null = null;
      const wakeUp = () => {
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };
      const push = (part: StreamPart) => {
        queue.push(part);
        // Backpressure: pause the source streams while output is buffered; the
        // consumer resumes them after it drains the queue, bounding memory.
        child.stdout?.pause();
        child.stderr?.pause();
        wakeUp();
      };
      let timedOut = false;
      let cancelled = false;
      const timer = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killChild(child);
          }, spec.timeoutMs)
        : undefined;
      timer?.unref?.();
      const onAbort = () => {
        cancelled = true;
        killChild(child);
      };
      if (spec.signal?.aborted) onAbort();
      else spec.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => push({ type: "stdout", chunk: d }));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => push({ type: "stderr", chunk: d }));
      child.on("error", (err: NodeJS.ErrnoException) => {
        push({ type: "error", error: { message: err.message, code: err.code } });
        finished = true;
        wakeUp();
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          push({ type: "error", error: { message: `Shell command timed out after ${spec.timeoutMs}ms`, code: "ETIMEDOUT" } });
        } else if (cancelled) {
          push({ type: "error", error: { message: "Shell command cancelled", code: "ECANCELLED" } });
        } else {
          push({ type: "exit", exitCode: code ?? 0, signal: signal ?? null });
        }
        finished = true;
        wakeUp();
      });
      writeStdin(child, spec.stdin);
      try {
        while (true) {
          while (queue.length) yield queue.shift() as StreamPart;
          if (finished) return;
          // Drained — resume the source and wait for the next record.
          child.stdout?.resume();
          child.stderr?.resume();
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      } finally {
        // Early termination (consumer break/return, a downstream throw, the
        // enclosing sequence failing) lands here without `close` having fired —
        // tear down the whole process group and clear timer/abort listener.
        if (timer) clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onAbort);
        killChild(child);
      }
    },
  };
}

class LocalShellHost implements ShellHost, ResourceInstance {
  constructor(
    private readonly cwd: string,
    private readonly shell: string,
    private readonly baseEnv: Record<string, string>,
    private readonly hostEnv: Record<string, string>,
  ) {}

  snapshot(): Record<string, unknown> {
    return {};
  }

  exec(command: string, options: RunOptions, ctx?: InvokeContext): ExecutionHandle {
    const { file, args } = shellInvocation(this.shell, command);
    const spec: SpawnSpec = {
      file,
      args,
      cwd: this.cwd,
      env: { ...this.hostEnv, ...this.baseEnv, ...(options.env ?? {}) },
      signal: ctx?.cancellation.signal,
      timeoutMs: options.timeoutMs,
      stdin: options.stdin,
      command,
    };
    return {
      buffered: () => runBuffered(spec),
      stream: () => runStream(spec),
    };
  }
}

export function register(): void {}

export async function create(
  resource: LocalHostManifest,
  ctx: ResourceContext,
): Promise<LocalShellHost> {
  const hostEnv = toEnvRecord(ctx.env);
  return new LocalShellHost(
    resource.cwd ?? ".",
    resource.shell ?? defaultShell(hostEnv),
    resource.env ?? {},
    hostEnv,
  );
}
