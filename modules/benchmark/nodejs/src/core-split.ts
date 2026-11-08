/** What the host offers for pinning, read once before any subject starts. */
export interface HostCpuFacts {
  platform: string;
  hasProc: boolean;
  hasTaskset: boolean;
  /** `getconf CLK_TCK`, the unit of `/proc/<pid>/stat` CPU times; undefined when unreadable. */
  clockTicks: number | undefined;
  /** CPUs this process may run on. */
  allowedCpus: number[];
  /** Each CPU's SMT siblings (itself included); undefined when `/sys` has no topology. */
  siblingsOf: ((cpu: number) => number[] | undefined) | undefined;
}

export type CoreSplit =
  | { ok: true; generatorCpus: number[]; subjectCpus: number[]; clockTicks: number }
  | { ok: false; reason: string };

/**
 * Splits the whole physical cores this process may use into two halves, SMT siblings kept
 * together: the lower half for the generator, the upper half (with an odd core) for subjects.
 */
export function splitCores(facts: HostCpuFacts): CoreSplit {
  if (facts.platform !== "linux") return { ok: false, reason: facts.platform };
  if (!facts.hasProc) return { ok: false, reason: "linux, no /proc" };
  if (!facts.hasTaskset) return { ok: false, reason: "linux, no taskset on PATH" };
  if (facts.clockTicks === undefined) return { ok: false, reason: "linux, no getconf CLK_TCK" };
  if (!facts.siblingsOf) return { ok: false, reason: "linux, no CPU topology in /sys" };

  const allowed = new Set(facts.allowedCpus);
  const cores = new Map<string, number[]>();
  for (const cpu of [...allowed].sort((a, b) => a - b)) {
    const siblings = facts.siblingsOf(cpu) ?? [cpu];
    if (!siblings.every((s) => allowed.has(s))) continue;
    const key = [...siblings].sort((a, b) => a - b).join(",");
    if (!cores.has(key)) cores.set(key, [...siblings].sort((a, b) => a - b));
  }
  const ordered = [...cores.values()].sort((a, b) => a[0] - b[0]);
  if (ordered.length < 2) {
    const n = ordered.length;
    return { ok: false, reason: `linux, ${n} whole physical core${n === 1 ? "" : "s"} available` };
  }
  const half = Math.floor(ordered.length / 2);
  return {
    ok: true,
    generatorCpus: ordered.slice(0, half).flat(),
    subjectCpus: ordered.slice(half).flat(),
    clockTicks: facts.clockTicks,
  };
}

/** Parses a kernel CPU list (`0-3,8,10-11`). */
export function parseCpuList(text: string): number[] {
  const cpus: number[] = [];
  for (const part of text.trim().split(",")) {
    if (part === "") continue;
    const [from, to] = part.split("-").map((n) => Number.parseInt(n, 10));
    if (!Number.isInteger(from) || (to !== undefined && !Number.isInteger(to))) {
      throw new Error(`Unreadable CPU list "${text}"`);
    }
    for (let cpu = from; cpu <= (to ?? from); cpu++) cpus.push(cpu);
  }
  return cpus;
}

export function formatCpuList(cpus: number[]): string {
  return cpus.join(",");
}
