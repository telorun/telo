#!/usr/bin/env node
// Two dimensions, run from a repo root: `node .claude/skills/rust-parity/sweep.mjs --out <file>
// [--dimension run|check] [--filter <text>] [--only rust|node] [--concurrency <n>] [--timeout <seconds>]
// [--reuse-node <earlier out file> [--reuse-node-any-commit]]` (default: both dimensions).
//
// `run` runs every manifest test `test-suite.yaml` discovers on both kernels and writes one verdict
// per test per kernel.
//
// `check` runs `telo check` of both CLIs over every manifest the repo holds whose first document is
// a `Telo.Application` or `Telo.Library`, and judges Rust against Node by `check-debt.json` (below).
// It exits non-zero when it finds a difference the debt list does not allow, or a stale entry.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const root = process.cwd();
const suitePath = join(root, "test-suite.yaml");
if (!existsSync(suitePath)) fail(`no test-suite.yaml in ${root}; run from the repo root`);

const YAML = createRequire(join(root, "package.json"))("yaml");
// The `check` dimension's constants, declared before the main flow awaits.
const CHECK_DEBT_FILE = join(root, ".claude", "skills", "rust-parity", "check-debt.json");
// The slice that builds `telo check` owes nothing: its debt is nothing.
const CHECK_SLICE_OWNER = /^3a-2\b|slice 14\b/;
const TOOL_MISSING = "CONTROLLER_TOOL_MISSING";
// A rule's evaluation budget is wall-clock time, so whether it is exceeded depends on the load.
const RULE_BUDGET = /exceeded its evaluation budget \(\d+ms\)/;
const OVER_BUDGET_CODES = new Set(["RESOURCE_RULE_INVALID", "REFERRER_RULE_INVALID"]);
// The code a CLI prints on stderr when it holds a construct back.
const HOST_REFUSAL = "ERR_UNSUPPORTED_MANIFEST_FEATURE";
// How a debt entry names a diagnostic that carries no code (a load failure).
const NO_CODE = "(none)";

const dimensions = options.dimension ? [options.dimension] : ["run", "check"];

const nodeCommand = options.only === "rust" ? null : readPackageScript("telo").split(/\s+/);
const rustBinary = options.only === "node" ? null : buildRust();

const report = { generatedAt: new Date().toISOString(), commit: git(["rev-parse", "HEAD"]).trim(), filter: options.filter };
let failed = false;

if (dimensions.includes("run")) {
  const { summary, results } = await runDimension();
  Object.assign(report, { summary, results });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
if (dimensions.includes("check")) {
  const check = await checkDimension();
  report.check = check;
  failed = check.summary.failed > 0;
  process.stdout.write(`${JSON.stringify({ check: check.summary })}\n`);
}

mkdirSync(dirname(resolve(options.out)), { recursive: true });
writeFileSync(options.out, JSON.stringify(report, null, 2));
if (failed) process.exit(1);

function buildRust() {
  const build = spawnSync("cargo", ["build", "--release", "--locked", "-p", "telo-cli"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.status !== 0) fail(`cargo build of telo-cli failed (exit ${build.status})`);
  return join(root, "target", "release", process.platform === "win32" ? "telo.exe" : "telo");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// The `run` dimension: every manifest test the suite discovers, on both kernels.
async function runDimension() {
  const suiteVariables = YAML.parseAllDocuments(readFileSync(suitePath, "utf8"), {
    logLevel: "silent",
  })[0].toJS().variables;
  const include = suiteVariables.include.default;
  const exclude = suiteVariables.exclude.default;

  const tests = globSync(include, { cwd: root, exclude })
    .filter((path) => path.includes(options.filter))
    .sort();

  const kernels = {};
  if (nodeCommand) {
    const [command, ...args] = nodeCommand;
    kernels.node = (test) => [command, [...args, test]];
  }
  if (rustBinary) kernels.rust = (test) => [rustBinary, ["run", test]];

  const results = new Array(tests.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, tests.length) }, async () => {
      while (next < tests.length) {
        const index = next++;
        const test = tests[index];
        const result = { path: test };
        for (const [name, commandFor] of Object.entries(kernels)) {
          result[name] = await runTest(commandFor(test), test);
        }
        results[index] = result;
        process.stderr.write(
          `${test}  ${Object.keys(kernels).map((k) => `${k}:${result[k].passed ? "pass" : "FAIL"}`).join("  ")}\n`,
        );
      }
    }),
  );

  const count = (predicate) => results.filter(predicate).length;
  const summary = {
    discovered: results.length,
    nodePassed: kernels.node ? count((r) => r.node.passed) : null,
    rustPassed: kernels.rust ? count((r) => r.rust.passed) : null,
    rustPassedOfTarget:
      kernels.node && kernels.rust ? count((r) => r.node.passed && r.rust.passed) : null,
  };
  return { summary, results };
}

function runTest([command, args], test) {
  const start = Date.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env: envForManifest(test) });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ passed: false, exitCode: null, timedOut, durationMs: Date.now() - start, tail: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({
        passed: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - start,
        tail: output.split(/\r?\n/).slice(-60).join("\n"),
      });
    });
  });
}

// The environment the suite gives a test: `.env`, then `.env.local`, beside the manifest, both
// overridden by the host environment — with the workspace's own binaries on PATH, as `pnpm run`
// puts them.
function envForManifest(test) {
  const dir = dirname(join(root, test));
  return {
    ...readEnvFile(join(dir, ".env")),
    ...readEnvFile(join(dir, ".env.local")),
    ...process.env,
    PATH: [join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter),
  };
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    values[trimmed.slice(0, eq).trim()] = value;
  }
  return values;
}

function readPackageScript(name) {
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.[name];
  if (!script) fail(`package.json has no "${name}" script`);
  return script;
}

// ---------------------------------------------------------------------------------------------
// The `check` dimension: `telo check` of the Rust CLI against Node's, over every manifest whose
// first document is a `Telo.Application` or `Telo.Library`.
//
// Both CLIs run with `--no-cache-write` under one sweep-owned `TELO_CACHE_DIR`, one invocation per
// manifest and form (`-o json`, then the text form where the manifest has no debt entry), the
// working directory the repo root, `NO_COLOR` set. `CONTROLLER_TOOL_MISSING` and a rule that "exceeded its
// evaluation budget" (a `RESOURCE_RULE_INVALID` or `REFERRER_RULE_INVALID` with that sentence) — statements
// about the machine and its load, not the manifest, and different on every run — are dropped from both
// payloads and the counts recomputed; a manifest whose Node text run reports one is not byte-compared.
//
// What passes is `check-debt.json`'s to say:
//   - a Rust diagnostic not equal, as a whole, to one of Node's always fails: the Rust analyzer may
//     under-report and never over-report;
//   - a Node diagnostic Rust lacks passes only when its code is in the manifest's `codes`;
//   - the exit status and `ok` may differ only under `unsupported` (Rust holds the file back and
//     says so) or when the only diagnostics Rust lacks are errors;
//   - a manifest with no entry also matches Node's text, stdout and stderr, byte for byte;
//   - an entry that no longer holds is stale and fails: a listed code no longer missing, an
//     `unsupported` on a manifest Rust reads whole, a path not in the repo's covered set, a code
//     with no owner, an owner in the slice that builds the check itself.

async function checkDimension() {
  const debt = readDebt();
  const covered = coveredManifests();
  const swept = covered.filter((path) => path.includes(options.filter));
  const cacheDir = mkdtempSync(join(tmpdir(), "rp-check-cache-"));
  const previous = options.reuseNode ? readReusedNode(options.reuseNode) : new Map();

  const invoke = (cli, path, mode) => {
    const [command, args] = cli === "node" ? [nodeCommand[0], nodeCommand.slice(1)] : [rustBinary, []];
    const flags = mode === "json" ? ["check", "--no-cache-write", "-o", "json", path] : ["check", "--no-cache-write", path];
    return runCapture(command, [...args, ...flags], {
      ...process.env,
      TELO_CACHE_DIR: cacheDir,
      NO_COLOR: "1",
    });
  };

  const results = new Array(swept.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, swept.length) }, async () => {
      while (next < swept.length) {
        const index = next++;
        const path = swept[index];
        const result = { path };
        const wantText = !debt.manifests[path];
        for (const cli of ["node", "rust"]) {
          if (!(cli === "node" ? nodeCommand : rustBinary)) continue;
          const reused = cli === "node" ? previous.get(path) : undefined;
          result[cli] = reused ?? { json: await invoke(cli, path, "json") };
          if (wantText && !result[cli].text) result[cli].text = await invoke(cli, path, "text");
        }
        result.verdict = nodeCommand && rustBinary ? judgeCheck(path, result, debt) : { status: "unjudged", failures: [] };
        results[index] = result;
        process.stderr.write(`check ${path}  ${result.verdict.status}\n`);
      }
    }),
  );

  const failures = results.flatMap((r) => r.verdict.failures.map((message) => ({ path: r.path, message })));
  if (nodeCommand && rustBinary) failures.push(...staleEntries(debt, covered, swept, results));
  for (const { path, message } of failures) process.stderr.write(`CHECK FAIL ${path}: ${message}\n`);

  const byStatus = (status) => results.filter((r) => r.verdict.status === status).length;
  const missingByCode = {};
  const missingByOwner = {};
  for (const r of results) {
    for (const code of r.verdict.missingCodes ?? []) {
      missingByCode[code] = (missingByCode[code] ?? 0) + 1;
      const owner = debt.owners[code] ?? "(no owner)";
      missingByOwner[owner] = (missingByOwner[owner] ?? 0) + 1;
    }
  }
  const summary = {
    swept: results.length,
    matched: byStatus("match"),
    debtListed: byStatus("debt"),
    nodeUnusable: byStatus("node-unusable"),
    unjudged: byStatus("unjudged"),
    failed: failures.length,
    manifestsFailing: results.filter((r) => r.verdict.status === "fail").length,
    missingByCode,
    missingByOwner,
  };
  return { summary, failures, results: results.map(({ path, node, rust, verdict }) => ({ path, verdict, node, rust })) };
}

function readDebt() {
  if (!existsSync(CHECK_DEBT_FILE)) fail(`${CHECK_DEBT_FILE} does not exist`);
  const debt = JSON.parse(readFileSync(CHECK_DEBT_FILE, "utf8"));
  if (!debt.owners || !debt.manifests) fail("check-debt.json needs `owners` and `manifests`");
  return debt;
}

// Every tracked or untracked-not-ignored YAML file whose first document is an Application or a Library.
function coveredManifests() {
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.yaml", "*.yml"])
    .split("\0")
    .filter(Boolean)
    .sort();
  return [...new Set(files)].filter((path) => {
    if (!existsSync(join(root, path))) return false;
    return ["Telo.Application", "Telo.Library"].includes(firstDocumentKind(readFileSync(join(root, path), "utf8")));
  });
}

function firstDocumentKind(text) {
  try {
    const first = YAML.parseAllDocuments(text, { logLevel: "silent" })[0];
    const kind = first?.toJS({ maxAliasCount: -1 })?.kind;
    if (typeof kind === "string") return kind;
  } catch {
    // A first document that does not read is still read by its text below.
  }
  const head = text.replace(/^\uFEFF/, "").split(/^---[ \t]*$/m).find((chunk) => /^[^#\s]/m.test(chunk)) ?? "";
  return /^kind:[ \t]*["']?([A-Za-z.]+)/m.exec(head)?.[1];
}

// A reused Node run is only what HEAD's Node would say when it was made at HEAD.
function readReusedNode(file) {
  const earlier = JSON.parse(readFileSync(file, "utf8"));
  if (earlier.commit !== report.commit) {
    const message = `--reuse-node ${file} was made at commit ${earlier.commit ?? "(none)"}, but HEAD is ${report.commit}`;
    if (!options.reuseNodeAnyCommit) fail(`${message}; re-run the Node sweep at HEAD or pass --reuse-node-any-commit`);
    process.stderr.write(`sweep: warning: ${message}\n`);
  }
  return new Map((earlier.check?.results ?? []).filter((r) => r.node).map((r) => [r.path, r.node]));
}

function runCapture(command, args, env) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, stdout, stderr, timedOut });
    });
  });
}

// One CLI's `-o json` run as data: its diagnostics without the machine's, counts recomputed.
function readPayload(run) {
  if (run.timedOut) return { unusable: "timed out" };
  if (run.exitCode !== 0 && run.exitCode !== 1) return { unusable: `exit ${run.exitCode}: ${tail(run.stderr)}` };
  let payload;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    return { unusable: `stdout is not JSON: ${tail(run.stdout)} ${tail(run.stderr)}` };
  }
  const diagnostics = payload.diagnostics.filter((d) => d.code !== TOOL_MISSING && !isOverBudget(d));
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warnCount = diagnostics.length - errorCount;
  // A host refusal: `ok: false` with no error, or the refusal's code on stderr beside a real error
  // of another file (a held-back file the envelope does not count as refused).
  const refused = (payload.ok === false && errorCount === 0) || run.stderr.includes(`[${HOST_REFUSAL}]`);
  return { diagnostics, errorCount, warnCount, refused, ok: errorCount === 0 && !refused, exitCode: run.exitCode, stderr: run.stderr };
}

// Node's over-budget finding: its code and its sentence together, never the sentence alone.
function isOverBudget(diagnostic) {
  return OVER_BUDGET_CODES.has(diagnostic.code) && RULE_BUDGET.test(diagnostic.message);
}

function tail(text) {
  return text.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
}

function judgeCheck(path, result, debt) {
  const entry = debt.manifests[path];
  const node = readPayload(result.node.json);
  const rust = readPayload(result.rust.json);
  const failures = [];
  if (node.unusable) return { status: "node-unusable", failures: [], note: node.unusable };
  if (rust.unusable) return { status: "fail", failures: [`Rust: ${rust.unusable}`] };

  // Every Rust diagnostic must be one of Node's, whole.
  const unmatched = node.diagnostics.map((d) => JSON.stringify(d));
  for (const d of rust.diagnostics) {
    const at = unmatched.indexOf(JSON.stringify(d));
    if (at === -1) failures.push(`Rust reports what Node does not: ${JSON.stringify(d)}`);
    else unmatched.splice(at, 1);
  }
  const missing = unmatched.map((text) => JSON.parse(text));
  const allowedCodes = new Set(entry?.codes ?? []);
  for (const d of missing) {
    if (!allowedCodes.has(d.code ?? NO_CODE)) failures.push(`Rust lacks ${d.code ?? NO_CODE}: ${d.file}:${d.line}:${d.column} ${d.message}`);
  }

  const unsupportedAllowed = Boolean(entry?.unsupported) && rust.refused;
  if (rust.refused && !entry?.unsupported) failures.push(`Rust holds something back with no \`unsupported\` entry: ${tail(rust.stderr)}`);
  if (rust.exitCode !== node.exitCode || rust.ok !== node.ok) {
    // Node fails on errors Rust lacks (each held to the debt codes above), Rust on none.
    const missingErrorsExplain = missing.some((d) => d.severity === "error") && rust.errorCount === 0 && !rust.refused;
    if (!unsupportedAllowed && !missingErrorsExplain) {
      failures.push(`exit/ok differ: Node ${node.exitCode}/${node.ok}, Rust ${rust.exitCode}/${rust.ok}`);
    }
  }

  if (!entry) {
    const [n, r] = [result.node.text, result.rust.text];
    if (n && r && !RULE_BUDGET.test(n.stdout)) {
      if (n.stdout !== r.stdout) failures.push(`text stdout differs from Node's:\n--- node\n${n.stdout}--- rust\n${r.stdout}`);
      if (n.stderr !== r.stderr) failures.push(`text stderr differs from Node's:\n--- node\n${n.stderr}--- rust\n${r.stderr}`);
      if (n.exitCode !== r.exitCode) failures.push(`text exit differs: Node ${n.exitCode}, Rust ${r.exitCode}`);
    }
  }

  const missingCodes = [...new Set(missing.map((d) => d.code ?? NO_CODE))];
  const status = failures.length ? "fail" : entry ? "debt" : "match";
  return { status, failures, missingCodes, refused: rust.refused };
}

function staleEntries(debt, covered, swept, results) {
  const failures = [];
  const sweptSet = new Set(swept);
  const byPath = new Map(results.map((r) => [r.path, r]));
  for (const [code, owner] of Object.entries(debt.owners)) {
    if (CHECK_SLICE_OWNER.test(owner)) failures.push({ path: "check-debt.json", message: `code ${code} is owed by ${owner}, the slice that builds \`telo check\`: nothing it owes may be debt` });
  }
  for (const [path, entry] of Object.entries(debt.manifests)) {
    if (!covered.includes(path)) {
      failures.push({ path, message: "stale: the path is not a manifest the repo holds" });
      continue;
    }
    if (!sweptSet.has(path)) continue;
    const verdict = byPath.get(path).verdict;
    if (verdict.status === "node-unusable") continue;
    for (const code of entry.codes ?? []) {
      if (!(code in debt.owners)) failures.push({ path, message: `code ${code} has no owner in \`owners\`` });
      if (!(verdict.missingCodes ?? []).includes(code)) failures.push({ path, message: `stale: ${code} is no longer missing` });
    }
    if (entry.unsupported) {
      if (!entry.unsupported.construct || !entry.unsupported.owedBy) failures.push({ path, message: "`unsupported` needs `construct` and `owedBy`" });
      else if (CHECK_SLICE_OWNER.test(entry.unsupported.owedBy)) failures.push({ path, message: `unsupported is owed by ${entry.unsupported.owedBy}, the slice that builds \`telo check\`` });
      if (!verdict.refused) failures.push({ path, message: "stale: `unsupported` on a manifest Rust reads whole" });
    }
    if (!(entry.codes?.length) && !entry.unsupported) failures.push({ path, message: "stale: an entry that lists nothing" });
  }
  return failures;
}

function parseArgs(argv) {
  const parsed = {
    out: null,
    filter: "",
    only: null,
    concurrency: 3,
    timeout: 600,
    dimension: null,
    reuseNode: null,
    reuseNodeAnyCommit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--reuse-node-any-commit") {
      parsed.reuseNodeAnyCommit = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`${flag} needs a value`);
    if (flag === "--out") parsed.out = value;
    else if (flag === "--filter") parsed.filter = value;
    else if (flag === "--only" && (value === "rust" || value === "node")) parsed.only = value;
    else if (flag === "--dimension" && (value === "run" || value === "check")) parsed.dimension = value;
    else if (flag === "--reuse-node") parsed.reuseNode = value;
    else if (flag === "--concurrency") parsed.concurrency = positiveInteger(flag, value);
    else if (flag === "--timeout") parsed.timeout = positiveInteger(flag, value);
    else fail(`unknown argument ${flag} ${value}`);
  }
  if (!parsed.out) fail("--out <file> is required");
  return parsed;
}

function positiveInteger(flag, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive integer, got ${value}`);
  return number;
}

function fail(message) {
  process.stderr.write(`sweep: ${message}\n`);
  process.exit(1);
}
