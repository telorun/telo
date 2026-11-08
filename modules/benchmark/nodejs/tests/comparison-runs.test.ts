// Runs small comparisons through the telo CLI on this host. They need /proc and taskset, so
// they run on Linux only; the platform refusal itself is pinned by core-split.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync as makeTempDir, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "__fixtures__");
const repoRoot = resolve(here, "../../../..");
const bun = join(repoRoot, "node_modules/.bin/bun");
const cli = join(repoRoot, "cli/nodejs/bin/telo.ts");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mkdtempSync(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

function subjectDir(...scripts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "telo-benchmark-subject-"));
  for (const script of scripts) copyFileSync(join(fixtures, script), join(dir, script));
  return dir;
}

function runComparison(
  manifest: string,
  env: Record<string, string>,
  options: { cpus?: number[]; whileRunning?: (child: ChildProcess) => void } = {},
): Promise<Run> {
  const args = [cli, "run", join(fixtures, manifest)];
  const [command, argv] = options.cpus ? ["taskset", ["-c", options.cpus.join(","), bun, ...args]] : [bun, args];
  const started = performance.now();
  const child = spawn(command as string, argv as string[], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  options.whileRunning?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolvePromise) =>
    child.on("close", (code) => resolvePromise({ code, stdout, stderr, ms: performance.now() - started })),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePromise(port));
    });
  });
}

function cpuList(text: string): number[] {
  const cpus: number[] = [];
  for (const part of text.trim().split(",")) {
    const [from, to] = part.split("-").map(Number);
    for (let cpu = from; cpu <= (to ?? from); cpu++) cpus.push(cpu);
  }
  return cpus;
}

function allowedCpus(path: string): number[] | undefined {
  try {
    const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith("Cpus_allowed_list:"));
    return line ? cpuList(line.split(":")[1]) : undefined;
  } catch {
    return undefined; // the task ended between listing and reading
  }
}

function descendants(root: number): number[] {
  const tree = [root];
  for (let i = 0; i < tree.length; i++) {
    for (const tid of existsSync(`/proc/${tree[i]}/task`) ? readdirSync(`/proc/${tree[i]}/task`) : []) {
      try {
        const text = readFileSync(`/proc/${tree[i]}/task/${tid}/children`, "utf8").trim();
        if (text) tree.push(...text.split(/\s+/).map(Number));
      } catch {
        // the task ended between listing and reading
      }
    }
  }
  return tree;
}

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined; // the process ended
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

/** Whole physical cores this process may use, SMT siblings together, lowest CPU first. */
function wholeCores(): number[][] {
  const allowed = new Set(allowedCpus("/proc/self/status"));
  const cores = new Map<string, number[]>();
  for (const cpu of allowed) {
    const siblings = cpuList(readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`, "utf8"));
    if (siblings.every((s) => allowed.has(s))) cores.set(siblings.join(","), siblings);
  }
  return [...cores.values()].sort((a, b) => a[0] - b[0]);
}

const linux = process.platform === "linux";
const cores = linux ? wholeCores() : [];

describe.skipIf(!linux)("Benchmark.Comparison on this host", () => {
  it(
    "measures a stalling server open-loop on split cores, with a fresh state directory per boot and pass",
    async () => {
      const dir = subjectDir("server.mjs");
      const out = mkdtempSync(join(tmpdir(), "telo-benchmark-out-"));
      const port = await freePort();
      const sightings: Array<{ role: "generator" | "subject"; cpus: number[] }> = [];
      const run = await runComparison(
        "serving.yaml",
        { SUBJECT_DIR: dir, REPORT_FILE: join(out, "record.json"), BOOT_LOG: join(out, "boots.jsonl"), PORT: String(port) },
        {
          whileRunning: (child) => {
            const timer = setInterval(() => {
              const subjects = descendants(child.pid!).filter((pid) => cmdline(pid).includes("server.mjs"));
              if (subjects.length === 0) return; // pinning applies while a subject runs
              // The comparison is the process that started the subject.
              const comparison = parentOf(subjects[0]);
              const tasks = (pid: number) => (existsSync(`/proc/${pid}/task`) ? readdirSync(`/proc/${pid}/task`) : []);
              for (const pid of [comparison, ...subjects]) {
                if (pid === undefined) continue;
                const role = pid === comparison ? "generator" : "subject";
                for (const tid of tasks(pid)) {
                  const cpus = allowedCpus(`/proc/${pid}/task/${tid}/status`);
                  if (cpus) sightings.push({ role, cpus });
                }
              }
            }, 50);
            child.on("close", () => clearInterval(timer));
          },
        },
      );

      expect(run.code, run.stderr).toBe(1);
      expect(run.stderr).toMatch(/THRESHOLD FAIL \[ping\/stalling\] errorRate \d+\.\d\d% > 0\.00%/);
      expect(run.stdout).toMatch(/Errors\s+Subject\s+Workload\s+Status\s+Count\s+Message\s+Sample/);
      expect(run.stdout).toMatch(/stalling\s+ping\s+404\s+\d+\s+expected a 2xx status, got 404\s+\{"code":"NOT_FOUND"/);

      const record = JSON.parse(readFileSync(join(out, "record.json"), "utf8"));
      const [result] = record.workloadResults;
      // A stall of 200 ms every second delays every request scheduled during it.
      expect(result.p99Ms.median).toBeGreaterThan(150);
      expect(result.p50Ms.median).toBeLessThan(50);
      expect(result.errors.groups[0]).toMatchObject({ code: "404", message: "expected a 2xx status, got 404" });

      const { generatorCpus, subjectCpus } = record.host;
      expect(generatorCpus.filter((c: number) => subjectCpus.includes(c))).toEqual([]);
      expect(sightings.some((s) => s.role === "subject")).toBe(true);
      expect(sightings.some((s) => s.role === "generator")).toBe(true);
      for (const s of sightings) expect(s.cpus).toEqual(s.role === "subject" ? subjectCpus : generatorCpus);

      const boots = readFileSync(join(out, "boots.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // Two cold and two warm boots, then a throughput pass and a latency pass.
      expect(boots.map((b) => b.cacheExisted)).toEqual([false, true, false, true, true, true]);
      expect(boots.every((b) => b.stateWasEmpty)).toBe(true);
      expect(new Set(boots.map((b) => b.stateDir)).size).toBe(boots.length);
      expect(boots.filter((b) => existsSync(b.stateDir))).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual([".cache", "server.mjs"]);
    },
    60_000,
  );

  // Two whole cores: one generator core against one subject core. Whether the generator saturates
  // depends on the host, so this pins only that the measurement and the table agree; the bound
  // itself is pinned in comparison-record.test.ts.
  it.skipIf(cores.length < 2)(
    "measures the generator's utilization and marks the table when it saturated",
    async () => {
      const dir = subjectDir("fast-server.mjs");
      const out = mkdtempSync(join(tmpdir(), "telo-benchmark-out-"));
      const run = await runComparison(
        "saturation.yaml",
        { SUBJECT_DIR: dir, REPORT_FILE: join(out, "record.json"), PORT: String(await freePort()) },
        { cpus: [...cores[0], ...cores[1]] },
      );
      expect(run.code, run.stderr).toBe(0);
      const record = JSON.parse(readFileSync(join(out, "record.json"), "utf8"));
      const [result] = record.workloadResults;
      expect(result.throughput.median).toBeGreaterThan(0);
      const note = "* generator-bound: the load generator saturated its cores; this throughput is a lower bound.";
      if (result.generatorBound) {
        expect(run.stdout).toMatch(/hello\s+fast\s+\d+\.\d\*/);
        expect(run.stdout).toContain(note);
      } else {
        expect(run.stdout).toMatch(/hello\s+fast\s+\d+\.\d\s/);
        expect(run.stdout).not.toContain(note);
      }
    },
    60_000,
  );

  it(
    "refuses before any subject starts when fewer than two physical cores are available",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "telo-benchmark-out-"));
      const run = await runComparison(
        "serving.yaml",
        {
          SUBJECT_DIR: subjectDir("server.mjs"),
          REPORT_FILE: join(out, "record.json"),
          BOOT_LOG: join(out, "boots.jsonl"),
          PORT: String(await freePort()),
        },
        { cpus: cores[0] },
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        'Benchmark.Comparison "serving" samples process memory and CPU from /proc and pins cores with taskset, ' +
          "which this host (linux, 1 whole physical core available) does not have. Run it on Linux with at least 2 physical cores.",
      );
      expect(run.stderr).toContain("ERR_BENCHMARK_PLATFORM_UNSUPPORTED");
      expect(existsSync(join(out, "boots.jsonl"))).toBe(false);
    },
    60_000,
  );

  it(
    "fails a boot whose port is taken with the subject's exit code and last stderr line",
    async () => {
      const port = await freePort();
      const holder = createServer(); // accepts connections, never answers HTTP
      servers.push(holder);
      await new Promise<void>((r) => holder.listen(port, "127.0.0.1", () => r()));
      const out = mkdtempSync(join(tmpdir(), "telo-benchmark-out-"));
      const run = await runComparison("serving.yaml", {
        SUBJECT_DIR: subjectDir("server.mjs"),
        REPORT_FILE: join(out, "record.json"),
        BOOT_LOG: join(out, "boots.jsonl"),
        PORT: String(port),
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `Benchmark.Comparison "serving": subject "stalling" exited with code 1 before http://127.0.0.1:${port}/ping ` +
          `answered (round 1, cold boot 1). Last stderr line: Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
      );
      expect(run.stderr).toContain("ERR_BENCHMARK_BOOT_FAILED");
    },
    60_000,
  );

  it(
    "records boots and the startup span of subjects that run to exit, with no workload results",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "telo-benchmark-out-"));
      const dir = subjectDir("runner.mjs");
      const run = await runComparison("runs-to-exit.yaml", {
        SUBJECT_DIR: dir,
        REPORT_FILE: join(out, "record.json"),
        SPAN_MS: "42",
      });
      expect(run.code, run.stderr).toBe(0);
      const record = JSON.parse(readFileSync(join(out, "record.json"), "utf8"));
      expect(Object.keys(record)).toEqual(["teloVersion", "host", "bootResults", "workloadResults"]);
      expect(Object.keys(record.host)).toEqual(["os", "cpus", "model", "node", "generatorCpus", "subjectCpus"]);
      expect(record.workloadResults).toEqual([]);
      expect(record.bootResults.map((b: { subject: string }) => b.subject)).toEqual(["run", "check"]);
      expect(record.bootResults[0].startupMs).toEqual({ median: 42, min: 42, max: 42, cv: 0 });
      expect(record.bootResults[1].startupMs).toBeUndefined();
      expect(Object.keys(record.bootResults[1].coldMs)).toEqual(["median", "min", "max", "cv"]);
      expect(run.stdout).toMatch(/run\s+\d+ms\s+\d+ms\s+42ms/);
      expect(readdirSync(dir)).toEqual(["runner.mjs"]);
    },
    60_000,
  );

  it(
    "fails a subject that runs to exit with a non-zero code",
    async () => {
      const run = await runComparison("runs-to-exit.yaml", {
        SUBJECT_DIR: subjectDir("runner.mjs"),
        REPORT_FILE: join(mkdtempSync(join(tmpdir(), "telo-benchmark-out-")), "record.json"),
        EXIT_CODE: "3",
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        'Benchmark.Comparison "boots": subject "run" exited with code 3 (round 1, cold boot 1). Last stderr line: runner failing with 3',
      );
    },
    60_000,
  );

  it(
    "fails a subject that does not exit within its boot timeout",
    async () => {
      const run = await runComparison("runs-to-exit.yaml", {
        SUBJECT_DIR: subjectDir("runner.mjs"),
        REPORT_FILE: join(mkdtempSync(join(tmpdir(), "telo-benchmark-out-")), "record.json"),
        HANG: "1",
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Benchmark.Comparison "boots": subject "run" did not exit within 1s (round 1, cold boot 1)');
      expect(run.stderr).toContain("ERR_BENCHMARK_BOOT_FAILED");
    },
    60_000,
  );

  it(
    "fails a traceFile subject whose file holds no startup span",
    async () => {
      const run = await runComparison("runs-to-exit.yaml", {
        SUBJECT_DIR: subjectDir("runner.mjs"),
        REPORT_FILE: join(mkdtempSync(join(tmpdir(), "telo-benchmark-out-")), "record.json"),
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        'Benchmark.Comparison "boots": subject "run" names traceFile spans.jsonl, but after round 1, cold boot 1 it holds ' +
          'no "startup" span. Attach a Telo.LogTraceSink under tracing.sinks and a Telo.FileSink writing spans.jsonl under logging.sinks.',
      );
      expect(run.stderr).toContain("ERR_BENCHMARK_STARTUP_SPAN_MISSING");
    },
    60_000,
  );
});
