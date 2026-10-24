import { spawn, type ChildProcess } from "node:child_process";

import type { SelfInvocation } from "./self-invocation.js";

/**
 * One run of one application: the argv core built, run by the telo the app
 * runs on, as its own process group.
 *
 * `detached` on POSIX puts it in its own process group, which is what makes a
 * stop reach the whole tree — the kernel's own children (a controller's build,
 * a spawned tool) outlive a kill aimed at the parent alone, and a leaked
 * `telo run --watch` holding a port after the editor quits is the failure this
 * prevents. Windows has no process groups; the stop walks the tree with
 * `taskkill /T` there.
 */
export interface AppProcessArgs {
  telo: SelfInvocation;
  /** Core's argv; `argv[0]` is the program name the telo above stands in for. */
  argv: string[];
  cwd: string;
  /** The run's session env. */
  env: Record<string, string>;
}

export function spawnAppProcess(args: AppProcessArgs): ChildProcess {
  return spawn(args.telo.command, [...args.telo.prefix, ...args.argv.slice(1)], {
    cwd: args.cwd,
    // The workload inherits this process's environment — a local run's whole
    // point is the machine it runs on (PATH, HOME, certificates) — the run's
    // env wins over it, and the telo's own (`TELO_APP_CLI=1` for an executable
    // carrying an application) wins over both, since without it the child
    // would be that application rather than telo.
    env: { ...process.env, ...args.env, ...args.telo.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

/** Resolves once the process started; rejects with the reason it never ran. */
export function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) => reject(err));
  });
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM to the group so the kernel runs its teardown, SIGKILL after
 *  `graceMs` for what ignores it. Resolves once the process is gone. */
export async function stopAppProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || hasExited(child)) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    // Negative pid: the process GROUP `detached` gave it.
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: the group is already gone between the check and the signal.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}
