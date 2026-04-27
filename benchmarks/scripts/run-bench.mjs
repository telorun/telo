#!/usr/bin/env node
// Orchestrator for benchmark packages: spawn a server (native or Telo), wait
// for its port, run the benchmark, tear the server down, exit with the
// benchmark's status. Always cleans up on exit/signal.
//
// Usage (from a benchmark package directory):
//   node ../scripts/run-bench.mjs --server telo|native --port <n> --bench <yaml>
//   node ../scripts/run-bench.mjs --compare           --port <n> --bench <yaml>

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TELO_CLI = resolve(__dirname, "../../cli/nodejs/bin/telo.mjs");

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    bench: { type: "string" },
    port: { type: "string" },
    compare: { type: "boolean", default: false },
    timeout: { type: "string", default: "30" },
    api: { type: "string", default: "./api.yaml" },
    "api-native": { type: "string", default: "./api.ts" },
  },
});

if (!values.port) die("--port is required");
if (!values.bench) die("--bench is required");
if (!values.compare && !values.server) die("either --server or --compare is required");
if (values.server && !["native", "telo"].includes(values.server)) {
  die(`--server must be 'native' or 'telo', got '${values.server}'`);
}

const port = Number(values.port);
const benchAbs = resolve(process.cwd(), values.bench);
const apiAbs = resolve(process.cwd(), values.api);
const apiNativeAbs = resolve(process.cwd(), values["api-native"]);
const portWaitMs = Number(values.timeout) * 1000;

let activeServer = null;
process.on("SIGINT", () => cleanupAndExit(130));
process.on("SIGTERM", () => cleanupAndExit(143));

if (values.compare) {
  const native = await runVariant("native");
  if (native.exitCode !== 0 || !native.report) {
    process.stderr.write(`\nnative benchmark exited with code ${native.exitCode}\n`);
    process.exit(native.exitCode || 1);
  }
  const telo = await runVariant("telo");
  if (telo.exitCode !== 0 || !telo.report) {
    process.stderr.write(`\ntelo benchmark exited with code ${telo.exitCode}\n`);
    process.exit(telo.exitCode || 1);
  }
  printCompare(native.report, telo.report);
} else {
  const result = await runVariant(values.server);
  if (result.report) printSingle(values.server, result.report);
  process.exit(result.exitCode);
}

async function runVariant(kind) {
  process.stderr.write(`\n>>> ${kind}: starting server on :${port}\n`);
  const server = spawnServer(kind);
  activeServer = server;
  const serverLog = captureOutput(server);
  let exitedEarly = null;
  server.once("exit", (code) => {
    if (code !== 0 && code !== null) exitedEarly = code;
  });

  try {
    await waitForPort(port, portWaitMs, () => exitedEarly);
  } catch (err) {
    process.stderr.write(serverLog());
    await killServer(server);
    activeServer = null;
    die(`${kind}: ${err.message}`);
  }

  process.stderr.write(`>>> ${kind}: running benchmark\n`);
  const { exitCode, stdout } = await runBenchmark();
  await killServer(server);
  activeServer = null;

  if (exitCode !== 0) {
    process.stderr.write(serverLog());
  }

  let report = null;
  try {
    report = parseReport(stdout);
  } catch (err) {
    process.stderr.write(`\n${kind}: failed to parse benchmark JSON output\n`);
    process.stderr.write(stdout);
    if (exitCode === 0) process.exit(1);
  }
  return { exitCode, report };
}

function spawnServer(kind) {
  // detached:true gives the child its own process group so we can SIGTERM the
  // whole group — `tsx` and the `telo` CLI both fork node subprocesses that
  // wouldn't receive a signal sent only to the parent pid.
  const opts = {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  };
  if (kind === "native") {
    return spawn("npx", ["tsx", apiNativeAbs], opts);
  }
  return spawn("node", [TELO_CLI, "run", apiAbs], opts);
}

function runBenchmark() {
  return new Promise((resolveP) => {
    const child = spawn("node", [TELO_CLI, "run", benchAbs], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.once("exit", (code) => {
      resolveP({ exitCode: code ?? 0, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function captureOutput(child) {
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));
  return () => Buffer.concat(chunks).toString("utf8");
}

async function killServer(child) {
  if (child.exitCode !== null) return;
  // Negative pid targets the whole process group (set up by detached:true).
  // tsx and telo each fork a real node process that wouldn't otherwise see
  // the signal — this kills the actual port-holder.
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
  await new Promise((res) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      res();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      res();
    });
  });
}

async function waitForPort(p, timeoutMs, checkExit) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitCode = checkExit();
    if (exitCode !== null && exitCode !== undefined) {
      throw new Error(`server exited with code ${exitCode} before port ${p} opened`);
    }
    if (await tryConnect(p)) return;
    await sleep(150);
  }
  throw new Error(`port ${p} did not open within ${timeoutMs}ms`);
}

function tryConnect(p) {
  return new Promise((res) => {
    const sock = connect(p, "127.0.0.1");
    const finish = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      res(ok);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Telo's CLI may emit log lines around the JSON report. Take the longest
// {...} JSON object substring that parses.
function parseReport(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in output");
  return JSON.parse(text.slice(start, end + 1));
}

function fmtMs(n) {
  if (n >= 100) return `${Math.round(n)}ms`;
  if (n >= 10) return `${n.toFixed(1)}ms`;
  return `${n.toFixed(2)}ms`;
}
function fmtPct(n) {
  return `${(n * 100).toFixed(2)}%`;
}
function fmtRps(n) {
  return n.toFixed(1);
}

function printSingle(kind, report) {
  const cols = ["Scenario", "Reqs", "RPS", "p50", "p95", "p99", "Errors"];
  const rows = [];
  for (const [name, st] of Object.entries(report)) {
    rows.push([name, String(st.total), fmtRps(st.rps), fmtMs(st.p50), fmtMs(st.p95), fmtMs(st.p99), fmtPct(st.errorRate)]);
  }
  process.stdout.write(`\n=== ${kind} ===\n`);
  writeTable(cols, rows);
}

function printCompare(native, telo) {
  const scenarios = new Set([...Object.keys(native), ...Object.keys(telo)]);
  const cols = ["Scenario", "Impl", "Reqs", "RPS", "p50", "p95", "p99", "Errors"];
  const rows = [];
  for (const s of scenarios) {
    const n = native[s];
    const t = telo[s];
    rows.push(statsRow(s, "native", n));
    rows.push(statsRow("", "telo", t));
    rows.push(deltaRow(n, t));
    rows.push(pctRow(n, t));
  }
  process.stdout.write(`\n=== native vs telo ===\n`);
  writeTable(cols, rows);
}

function statsRow(scenario, impl, st) {
  if (!st) return [scenario, impl, "-", "-", "-", "-", "-", "-"];
  return [
    scenario,
    impl,
    String(st.total),
    fmtRps(st.rps),
    fmtMs(st.p50),
    fmtMs(st.p95),
    fmtMs(st.p99),
    fmtPct(st.errorRate),
  ];
}

function deltaRow(n, t) {
  if (!n || !t) return ["", "Δ", "-", "-", "-", "-", "-", "-"];
  return [
    "",
    "Δ",
    fmtIntDelta(n.total, t.total),
    fmtNumDelta(n.rps, t.rps, 1),
    fmtMsDelta(n.p50, t.p50),
    fmtMsDelta(n.p95, t.p95),
    fmtMsDelta(n.p99, t.p99),
    fmtPctPointDelta(n.errorRate, t.errorRate),
  ];
}

// Relative-percentage row: telo's natural sign convention. Negative on RPS/Reqs
// (telo did fewer); positive on latencies (telo took longer). Errors stays as
// the absolute pct-point delta on the Δ row, since native=0 makes a relative
// % undefined.
function pctRow(n, t) {
  if (!n || !t) return ["", "%", "-", "-", "-", "-", "-", "-"];
  return [
    "",
    "%",
    fmtRelPct(n.total, t.total),
    fmtRelPct(n.rps, t.rps),
    fmtRelPct(n.p50, t.p50),
    fmtRelPct(n.p95, t.p95),
    fmtRelPct(n.p99, t.p99),
    "—",
  ];
}

function fmtIntDelta(a, b) {
  const d = b - a;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}`;
}

function fmtNumDelta(a, b, places) {
  const d = b - a;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(places)}`;
}

function fmtMsDelta(a, b) {
  const d = b - a;
  const sign = d > 0 ? "+" : "";
  if (Math.abs(d) >= 10) return `${sign}${d.toFixed(1)}ms`;
  return `${sign}${d.toFixed(2)}ms`;
}

function fmtPctPointDelta(a, b) {
  const d = (b - a) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}%`;
}

function fmtRelPct(a, b) {
  if (a === 0) return "—";
  const d = ((b - a) / a) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}

function writeTable(cols, rows) {
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const pad = (s, w) => s.padEnd(w);
  process.stdout.write(cols.map((c, i) => pad(c, widths[i])).join("  ") + "\n");
  process.stdout.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (const r of rows) {
    process.stdout.write(r.map((cell, i) => pad(cell, widths[i])).join("  ") + "\n");
  }
  process.stdout.write("\n");
}

function die(msg) {
  process.stderr.write(`run-bench: ${msg}\n`);
  process.exit(2);
}

async function cleanupAndExit(code) {
  if (activeServer) await killServer(activeServer);
  process.exit(code);
}
