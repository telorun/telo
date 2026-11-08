import { existsSync, readdirSync, readFileSync } from "node:fs";

/** CPU time and resident memory of a process and every live descendant. */
export interface TreeSample {
  pids: number[];
  /** User + system time, reaped children included, in milliseconds. */
  cpuMs: number;
  rssBytes: number;
}

interface ProcStat {
  ppid: number;
  /** utime + stime, in clock ticks. */
  ownTicks: number;
  /** cutime + cstime: children already reaped. */
  reapedTicks: number;
}

// Fields after the parenthesised comm, which may itself hold spaces or parentheses.
function readStat(pid: number): ProcStat | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
      return undefined; // exited between listing and reading
    }
    throw error;
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  // fields[0] is field 3 (state): ppid is field 4, utime..cstime fields 14..17.
  const n = (field: number) => Number(fields[field - 3]);
  return { ppid: n(4), ownTicks: n(14) + n(15), reapedTicks: n(16) + n(17) };
}

function readRssBytes(pid: number): number {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return 0;
    throw error;
  }
  const match = text.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) * 1024 : 0;
}

const childrenFilesSupported = existsSync(`/proc/self/task/${process.pid}/children`);

function childrenOf(pid: number): number[] {
  const children: number[] = [];
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return children;
    throw error;
  }
  for (const tid of tasks) {
    let text: string;
    try {
      text = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw error;
    }
    for (const child of text.trim().split(/\s+/)) if (child !== "") children.push(Number(child));
  }
  return children;
}

/** Every live pid descended from `root`, `root` first. */
export function descendantsOf(root: number): number[] {
  if (!childrenFilesSupported) {
    const parentOf = new Map<number, number>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = readStat(Number(entry));
      if (stat) parentOf.set(Number(entry), stat.ppid);
    }
    const tree = [root];
    for (let i = 0; i < tree.length; i++) {
      for (const [pid, ppid] of parentOf) if (ppid === tree[i]) tree.push(pid);
    }
    return tree;
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...childrenOf(tree[i]));
  return tree;
}

export function sampleTree(root: number, clockTicks: number): TreeSample {
  const pids = descendantsOf(root);
  let ticks = 0;
  let rssBytes = 0;
  const live: number[] = [];
  for (const pid of pids) {
    const stat = readStat(pid);
    if (!stat) continue;
    live.push(pid);
    ticks += stat.ownTicks + stat.reapedTicks;
    rssBytes += readRssBytes(pid);
  }
  return { pids: live, cpuMs: (ticks * 1000) / clockTicks, rssBytes };
}

/** This process's own CPU time, every thread included and reaped children not, in milliseconds. */
export function ownCpuMs(clockTicks: number): number {
  const stat = readStat(process.pid);
  if (!stat) throw new Error("/proc/self/stat is unreadable");
  return (stat.ownTicks * 1000) / clockTicks;
}
