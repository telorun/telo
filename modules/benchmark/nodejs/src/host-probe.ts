import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { cpus as osCpus } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { formatCpuList, parseCpuList, type HostCpuFacts } from "./core-split.js";

export interface HostRecord {
  os: string;
  cpus: number;
  model: string;
  node: string;
  generatorCpus: number[];
  subjectCpus: number[];
}

function onPath(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not in this directory; the next one may hold it.
    }
  }
  return false;
}

function statusField(pid: number | "self", field: string): string | undefined {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const line = status.split("\n").find((l) => l.startsWith(`${field}:`));
  return line?.slice(field.length + 1).trim();
}

/** The CPUs `/proc/<pid>/status` allows the task to run on. */
export function allowedCpusOf(pid: number | "self"): number[] {
  const list = statusField(pid, "Cpus_allowed_list");
  if (list === undefined) throw new Error(`/proc/${pid}/status holds no Cpus_allowed_list`);
  return parseCpuList(list);
}

function readSiblings(cpu: number): number[] | undefined {
  const base = `/sys/devices/system/cpu/cpu${cpu}/topology`;
  for (const file of ["core_cpus_list", "thread_siblings_list"]) {
    if (existsSync(`${base}/${file}`)) return parseCpuList(readFileSync(`${base}/${file}`, "utf8"));
  }
  return undefined;
}

function readClockTicks(): number | undefined {
  try {
    const ticks = Number.parseInt(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(), 10);
    return Number.isInteger(ticks) && ticks > 0 ? ticks : undefined;
  } catch {
    return undefined;
  }
}

export function readHostCpuFacts(): HostCpuFacts {
  const platform = process.platform;
  const hasProc = platform === "linux" && existsSync("/proc/self/status");
  if (!hasProc) {
    return { platform, hasProc, hasTaskset: false, clockTicks: undefined, allowedCpus: [], siblingsOf: undefined };
  }
  const allowedCpus = allowedCpusOf("self");
  const hasTopology = allowedCpus.length > 0 && readSiblings(allowedCpus[0]) !== undefined;
  return {
    platform,
    hasProc,
    hasTaskset: onPath("taskset"),
    clockTicks: readClockTicks(),
    allowedCpus,
    siblingsOf: hasTopology ? readSiblings : undefined,
  };
}

/** Pins every thread of this process to `cpus`; threads started later inherit it. */
export function pinProcess(cpus: number[]): void {
  execFileSync("taskset", ["-a", "-p", "-c", formatCpuList(cpus), String(process.pid)], { stdio: "ignore" });
}

function osName(): string {
  if (!existsSync("/etc/os-release")) return process.platform;
  const fields = new Map<string, string>();
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) fields.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
  }
  const id = fields.get("ID") ?? process.platform;
  const version = fields.get("VERSION_ID");
  return version ? `${id}-${version}` : id;
}

function cpuModel(): string {
  const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
  const line = cpuinfo.split("\n").find((l) => /^model name\s*:/.test(l));
  return line ? line.slice(line.indexOf(":") + 1).trim() : (osCpus()[0]?.model.trim() ?? "unknown");
}

export function hostRecord(generatorCpus: number[], subjectCpus: number[]): HostRecord {
  return {
    os: osName(),
    cpus: osCpus().length,
    model: cpuModel(),
    node: process.versions.node,
    generatorCpus,
    subjectCpus,
  };
}

/**
 * The version of the telo CLI running this process, read from the `@telorun/cli` package that
 * holds the entry script; undefined when the process was not started from one (an embedder, a
 * single-file executable). The SDK a controller resolves is a generated shim carrying no version.
 */
export function teloCliVersion(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  let dir = dirname(resolvePath(entry));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@telorun/cli" && typeof pkg.version === "string") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
