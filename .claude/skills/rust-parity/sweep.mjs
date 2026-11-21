#!/usr/bin/env node
// Three dimensions, run from a repo root: `node .claude/skills/rust-parity/sweep.mjs --out <file>
// [--dimension run|check|load ...] [--filter <text>] [--only rust|node] [--concurrency <n>] [--timeout <seconds>]
// [--reuse-node <earlier out file> [--reuse-node-any-commit]]` (default: `run` and `check`; `--dimension`
// repeats, or takes a comma-separated list, to run several).
//
// `run` runs every manifest test `test-suite.yaml` discovers on both kernels and writes one verdict
// per test per kernel.
//
// `check` runs `telo check` of both CLIs over every manifest the repo holds whose first document is
// a `Telo.Application` or `Telo.Library`, and judges Rust against Node by `check-debt.json` (below).
// It exits non-zero when it finds a difference the debt list does not allow, or a stale entry.
//
// `load` loads every manifest of the `check` dimension's set with each kernel's analyze-only load
// (Node's `analyzeOnly` through `load-node.ts`, Rust's through the `analyze_only` example of
// `telo-kernel`) and compares what each refuses the load with, finding by finding (below). Run
// beside `check` with no `--filter`, it confirms each owed finding against the owner's own check.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const options = parseArgs(process.argv.slice(2));
const root = process.cwd();
const suitePath = join(root, "test-suite.yaml");
if (!existsSync(suitePath)) fail(`no test-suite.yaml in ${root}; run from the repo root`);

const YAML = createRequire(join(root, "package.json"))("yaml");
// The `check` dimension's constants, declared before the main flow awaits.
const CHECK_DEBT_FILE = join(root, ".claude", "skills", "rust-parity", "check-debt.json");
// A completed slice owes nothing: 3a-2 (slice 14, which builds `telo check`) and 3a-3 (slice 15, the
// module graph).
const CHECK_SLICE_OWNER = /^3a-[23]\b|slice 1[45]\b/;
const TOOL_MISSING = "CONTROLLER_TOOL_MISSING";
// A rule's evaluation budget is wall-clock time, so whether it is exceeded depends on the load.
const RULE_BUDGET = /exceeded its evaluation budget \(\d+ms\)/;
const OVER_BUDGET_CODES = new Set(["RESOURCE_RULE_INVALID", "REFERRER_RULE_INVALID"]);
// The code a CLI prints on stderr when it holds a construct back.
const HOST_REFUSAL = "ERR_UNSUPPORTED_MANIFEST_FEATURE";
// How a debt entry names a diagnostic that carries no code (a load failure).
const NO_CODE = "(none)";

const dimensions = options.dimensions.length ? options.dimensions : ["run", "check"];
// The `check` dimension's per-manifest analyses, which the `load` dimension confirms against.
let checkAnalyses = null;
// The built analyzer's `runtimeCodeOf`, read once (`loadRuntimeCodeOf`).
let builtRuntimeCodeOf = null;

const nodeCommand = options.only === "rust" ? null : readPackageScript("telo").split(/\s+/);
const rustBinary = options.only === "node" || !dimensions.some((d) => d === "run" || d === "check") ? null : buildRust();
const rustLoader = options.only === "node" || !dimensions.includes("load") ? null : buildRustLoader();

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
if (dimensions.includes("load")) {
  const load = await loadDimension();
  report.load = load;
  failed ||= load.summary.failed > 0;
  process.stdout.write(`${JSON.stringify({ load: load.summary })}\n`);
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

function buildRustLoader() {
  const build = spawnSync("cargo", ["build", "--release", "--locked", "-p", "telo-kernel", "--example", "analyze_only"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.status !== 0) fail(`cargo build of the analyze_only example failed (exit ${build.status})`);
  return join(root, "target", "release", "examples", process.platform === "win32" ? "analyze_only.exe" : "analyze_only");
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
// manifest and form (`-o json`, then the text form where the JSON payloads agree whole), the
// working directory the repo root, `NO_COLOR` set. `CONTROLLER_TOOL_MISSING` and a rule that "exceeded its
// evaluation budget" (a `RESOURCE_RULE_INVALID` or `REFERRER_RULE_INVALID` with that sentence) — statements
// about the machine and its load, not the manifest, and different on every run — are dropped from both
// payloads and the counts recomputed; a manifest whose Node text run reports one is not byte-compared.
//
// What passes is `check-debt.json`'s to say, each finding judged against the module that WRITES it:
//   - a Rust diagnostic not equal, as a whole, to one of Node's always fails: the Rust analyzer may
//     under-report and never over-report;
//   - a Node diagnostic Rust lacks, written in the manifest's own file (or a partial it `include:`s),
//     passes only when its code is in the manifest's `codes`;
//   - one written in a file of ANOTHER module M (a dependency's verdict) is judged by DEFECT IDENTITY
//     across runs — its code, file, path and resource (`sameDefect`, below), never its message — against
//     M's own run in the same sweep (M keyed by its own manifest path, a partial mapped to its owner
//     through the covered manifests' `include:` lists): when M's own Node run reports that defect, it
//     passes only when M's entry lists the code AND M's own Rust run lacks it; when M's own Node run
//     does not report it, it is a CONTEXT finding the consumer's composition makes, owed to the manifest
//     itself, passing only when the manifest's own entry lists the code, which then counts among the
//     manifest's own missing codes for staleness; under `--filter` M's or the manifest's entry listing
//     the code passes, the full sweep confirms;
//   - the exit status and `ok` may differ only under `unsupported` (Rust holds the file back and
//     says so) or when the only diagnostics Rust lacks are errors;
//   - wherever the two JSON payloads agree whole, the text form is also compared, byte for byte;
//   - an entry that no longer holds is stale and fails: a listed code no longer missing in the module's
//     own run (its own files and its context findings), an `unsupported` on a manifest Rust reads whole,
//     a path not in the repo's covered set, a code with no owner (the entry's own `owners` override,
//     else `owners`), an override naming a code the entry does not list, an owner that is a completed
//     slice. So no consumer entry may list a code only a library's own check reports.

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
      PATH: [join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter),
    });
  };

  const owners = includeOwners(covered);
  const analyses = new Map();
  const results = new Array(swept.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, swept.length) }, async () => {
      while (next < swept.length) {
        const index = next++;
        const path = swept[index];
        const result = { path };
        for (const cli of ["node", "rust"]) {
          if (!(cli === "node" ? nodeCommand : rustBinary)) continue;
          result[cli] = previous.get(path)?.json && cli === "node" ? previous.get(path) : { json: await invoke(cli, path, "json") };
        }
        if (nodeCommand && rustBinary) {
          const analysis = analyzeCheck(path, result, owners);
          analyses.set(path, analysis);
          if (analysis.agree) {
            for (const cli of ["node", "rust"]) {
              if (!result[cli].text) result[cli].text = await invoke(cli, path, "text");
            }
          }
          result.verdict = judgeCheck(path, result, debt, analysis);
        } else {
          result.verdict = { status: "unjudged", failures: [] };
        }
        results[index] = result;
        process.stderr.write(`check ${path}  ${result.verdict.status}\n`);
      }
    }),
  );

  if (nodeCommand && rustBinary) {
    judgeDependencyFindings(results, analyses, debt, await loadRuntimeCodeOf());
    checkAnalyses = analyses;
  }

  const failures = results.flatMap((r) => r.verdict.failures.map((message) => ({ path: r.path, message })));
  if (nodeCommand && rustBinary) failures.push(...staleEntries(debt, covered, swept, results));
  for (const { path, message } of failures) process.stderr.write(`CHECK FAIL ${path}: ${message}\n`);

  const byStatus = (status) => results.filter((r) => r.verdict.status === status).length;
  const missingByCode = {};
  const missingByOwner = {};
  for (const r of results) {
    for (const code of r.verdict.missingCodes ?? []) {
      missingByCode[code] = (missingByCode[code] ?? 0) + 1;
      const owner = ownerOf(debt, r.path, code) ?? "(no owner)";
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

// The slice owing `code` at `path`: the entry's own `owners` override, else the code's.
function ownerOf(debt, path, code) {
  return debt.manifests[path]?.owners?.[code] ?? debt.owners[code];
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

// The modules a file belongs to: a covered manifest is its own; a partial belongs to every covered
// manifest whose `include:` patterns (relative to that manifest's directory) reach it.
function includeOwners(covered) {
  const map = new Map(covered.map((path) => [path, [path]]));
  for (const path of covered) {
    const text = readFileSync(join(root, path), "utf8");
    if (!/^include:/m.test(text)) continue;
    const include = YAML.parseAllDocuments(text, { logLevel: "silent" })[0]?.toJS({ maxAliasCount: -1 })?.include;
    if (!Array.isArray(include)) continue;
    const dir = dirname(path);
    for (const pattern of include.filter((p) => typeof p === "string")) {
      for (const match of globSync(pattern, { cwd: join(root, dir) })) {
        const file = (dir === "." ? match : join(dir, match)).split("\\").join("/");
        if (map.has(file) && map.get(file)[0] === file) continue;
        map.set(file, [...(map.get(file) ?? []), path]);
      }
    }
  }
  return map;
}

// Both CLIs' payloads side by side: what Rust adds, what it lacks, and where the lacks are written.
function analyzeCheck(path, result, owners) {
  const node = readPayload(result.node.json);
  const rust = readPayload(result.rust.json);
  const analysis = { node, rust, extra: [], missing: [], own: [], foreign: [], agree: false };
  if (node.unusable || rust.unusable) return analysis;
  const unmatched = node.diagnostics.map((d) => JSON.stringify(d));
  for (const d of rust.diagnostics) {
    const at = unmatched.indexOf(JSON.stringify(d));
    if (at === -1) analysis.extra.push(d);
    else unmatched.splice(at, 1);
  }
  analysis.missing = unmatched.map((text) => JSON.parse(text));
  for (const d of analysis.missing) {
    const fileOwners = d.file === undefined || d.file === path ? [path] : (owners.get(d.file) ?? []);
    (fileOwners.includes(path) ? analysis.own : analysis.foreign).push({ d, owners: fileOwners });
  }
  analysis.agree = !analysis.extra.length && !analysis.missing.length && rust.exitCode === node.exitCode && rust.ok === node.ok;
  return analysis;
}

// The findings written in the manifest's own module; those in another module's file wait for
// `judgeDependencyFindings`, which needs every module's own run.
function judgeCheck(path, result, debt, analysis) {
  const entry = debt.manifests[path];
  const { node, rust, missing } = analysis;
  const failures = [];
  if (node.unusable) return { status: "node-unusable", failures: [], note: node.unusable };
  if (rust.unusable) return { status: "fail", failures: [`Rust: ${rust.unusable}`] };

  for (const d of analysis.extra) failures.push(`Rust reports what Node does not: ${JSON.stringify(d)}`);
  const allowedCodes = new Set(entry?.codes ?? []);
  for (const { d } of analysis.own) {
    if (!allowedCodes.has(d.code ?? NO_CODE)) failures.push(`Rust lacks ${d.code ?? NO_CODE}: ${d.file}:${d.line}:${d.column} ${d.message}`);
  }

  const unsupportedAllowed = Boolean(entry?.unsupported) && rust.refused;
  if (rust.refused && !entry?.unsupported) failures.push(`Rust holds something back with no \`unsupported\` entry: ${tail(rust.stderr)}`);
  if (rust.exitCode !== node.exitCode || rust.ok !== node.ok) {
    // Node fails on errors Rust lacks (each held to the debt above), Rust on none.
    const missingErrorsExplain = missing.some((d) => d.severity === "error") && rust.errorCount === 0 && !rust.refused;
    if (!unsupportedAllowed && !missingErrorsExplain) {
      failures.push(`exit/ok differ: Node ${node.exitCode}/${node.ok}, Rust ${rust.exitCode}/${rust.ok}`);
    }
  }

  if (analysis.agree) {
    const [n, r] = [result.node.text, result.rust.text];
    if (n && r && !RULE_BUDGET.test(n.stdout)) {
      if (n.stdout !== r.stdout) failures.push(`text stdout differs from Node's:\n--- node\n${n.stdout}--- rust\n${r.stdout}`);
      if (n.stderr !== r.stderr) failures.push(`text stderr differs from Node's:\n--- node\n${n.stderr}--- rust\n${r.stderr}`);
      if (n.exitCode !== r.exitCode) failures.push(`text exit differs: Node ${n.exitCode}, Rust ${r.exitCode}`);
    }
  }

  const codesOf = (items) => [...new Set(items.map((d) => d.code ?? NO_CODE))];
  const status = failures.length ? "fail" : entry || missing.length ? "debt" : "match";
  return {
    status,
    failures,
    missingCodes: codesOf(missing),
    ownMissingCodes: codesOf(analysis.own.map(({ d }) => d)),
    refused: rust.refused,
  };
}

// A Node finding Rust lacks in another module's file: owed to the module whose own run writes it, or
// — a context finding — to the manifest itself (`judgeOwed`).
function judgeDependencyFindings(results, analyses, debt, runtimeCodeOf) {
  const lists = listsCode(debt, runtimeCodeOf);
  for (const result of results) {
    const entry = result.path;
    const analysis = analyses.get(entry);
    for (const { d, owners } of analysis.foreign) {
      const code = d.code ?? NO_CODE;
      const judged = judgeOwed({
        code,
        at: checkPlace(d, entry),
        entry,
        owners,
        lists,
        runtimeCodeOf,
        confirm: options.filter ? null : analyses,
      });
      const ownMissing = (result.verdict.ownMissingCodes ??= []);
      // Under `--filter` a foreign finding the manifest lists may be a context finding.
      const contextCode = judged.context || (options.filter && !judged.failure && lists(entry, code));
      if (contextCode && !ownMissing.includes(code)) ownMissing.push(code);
      if (!judged.failure) continue;
      result.verdict.failures.push(`Rust lacks ${code} in another module's file (${judged.failure}): ${d.file}:${d.line}:${d.column} ${d.message}`);
      result.verdict.status = "fail";
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Defect identity across runs, shared by the `check` and `load` dimensions. A finding of one run is
// the same defect as a finding of another when both are raised from one static code (a code C reaches
// the raised code as C itself or as the analyzer's `runtimeCodeOf(C)`; nothing maps backward) and both
// are WRITTEN at one place: the same file, the same field path (an empty one is none, as
// `telo check -o json` writes it) and the same resource. A finding's written place is its `writtenAt`
// when it carries one — a defect re-reported at an import reaching the module that writes it — and
// its own file, path and resource otherwise. Messages are never compared across runs: one defect is
// worded differently at an import and with a configuration clause, by design.

// A resource as `telo check -o json` writes it.
function resourceText(resource) {
  if (resource === undefined || resource === null) return undefined;
  return typeof resource === "string" ? resource : `${resource.kind}/${resource.name}`;
}

function place(file, path, resource) {
  return { file, path: path || undefined, resource: resourceText(resource) };
}

// Where a `check` finding of the run of `entry` is written.
function checkPlace(d, entry) {
  return place(d.file ?? entry, d.path, d.resource);
}

// Where a carried load finding of the load of `entry` is written.
function loadPlace(f, entry) {
  const at = f.writtenAt;
  return at ? place(at.filePath ?? entry, at.path, at.resource) : place(f.file, f.path, f.resource);
}

function codeReaches(staticCode, raised, runtimeCodeOf) {
  return staticCode === raised || (staticCode !== NO_CODE && runtimeCodeOf(staticCode) === raised);
}

// Whether `check` finding `d` of the run of `entry` is the defect raised as `code`, written at `at`.
function sameDefect(d, entry, code, at, runtimeCodeOf) {
  const own = checkPlace(d, entry);
  return codeReaches(d.code ?? NO_CODE, code, runtimeCodeOf) && own.file === at.file && own.path === at.path && own.resource === at.resource;
}

// Whether a manifest's debt entry lists a code reaching the raised `code`.
function listsCode(debt, runtimeCodeOf) {
  return (manifest, code) => (debt.manifests[manifest]?.codes ?? []).some((listed) => codeReaches(listed, code, runtimeCodeOf));
}

// A Node-only finding raised as `code` and written at `at`, in the run of `entry`, where `owners` are
// the modules owning `at.file`: `{ owners, confirmed, context? }` when it is owed, `{ failure }` when
// not. With `confirm` (the `check` dimension's analyses), a module whose own Node run reports the
// defect writes it, and its entry must list the code and its own Rust run lack it; a defect at
// another module's file no module's own run reports is a context finding, owed to `entry`, whose
// entry must list the code. Without `confirm`, any owner's entry or `entry`'s own listing it passes.
function judgeOwed({ code, at, entry, owners, lists, runtimeCodeOf, confirm }) {
  if (!owners.length) return { failure: `no module owns ${at.file}` };
  const ownFile = owners.includes(entry);
  if (!confirm) {
    const listed = [...new Set([...owners, entry])].filter((m) => lists(m, code));
    if (listed.length) return { owners: listed, confirmed: false };
    return { failure: `${[...new Set([...owners, entry])].join(", ")} lists no code raised as ${code}` };
  }
  const writers = owners.filter((m) => (confirm.get(m)?.node.diagnostics ?? []).some((d) => sameDefect(d, m, code, at, runtimeCodeOf)));
  if (writers.length) {
    const listed = writers.filter((m) => lists(m, code));
    if (!listed.length) return { failure: `${writers.join(", ")} writes it and lists no code raised as ${code}` };
    const confirmedBy = listed.filter((m) => confirm.get(m).own.some(({ d }) => sameDefect(d, m, code, at, runtimeCodeOf)));
    if (!confirmedBy.length) return { failure: `${listed.join(", ")} lists the code but its own check run does not lack this finding` };
    return { owners: confirmedBy, confirmed: true };
  }
  if (ownFile) return { failure: `${entry}'s own check run does not report this finding` };
  if (!lists(entry, code)) {
    return { failure: `a context finding: ${owners.join(", ")}'s own check run does not report it, and ${entry} lists no code raised as ${code}` };
  }
  return { owners: [entry], confirmed: true, context: true };
}

function staleEntries(debt, covered, swept, results) {
  const failures = [];
  const sweptSet = new Set(swept);
  const byPath = new Map(results.map((r) => [r.path, r]));
  for (const [code, owner] of Object.entries(debt.owners)) {
    if (CHECK_SLICE_OWNER.test(owner)) failures.push({ path: "check-debt.json", message: `code ${code} is owed by ${owner}, a completed slice: nothing it owes may be debt` });
  }
  for (const [path, entry] of Object.entries(debt.manifests)) {
    if (!covered.includes(path)) {
      failures.push({ path, message: "stale: the path is not a manifest the repo holds" });
      continue;
    }
    if (!sweptSet.has(path)) continue;
    const verdict = byPath.get(path).verdict;
    if (verdict.status === "node-unusable") continue;
    for (const [code, owner] of Object.entries(entry.owners ?? {})) {
      if (!(entry.codes ?? []).includes(code)) failures.push({ path, message: `stale: \`owners\` names ${code}, which the entry does not list` });
      if (CHECK_SLICE_OWNER.test(owner)) failures.push({ path, message: `code ${code} is owed by ${owner}, a completed slice` });
    }
    for (const code of entry.codes ?? []) {
      if (!ownerOf(debt, path, code)) failures.push({ path, message: `code ${code} has no owner in \`owners\`` });
      if (!(verdict.ownMissingCodes ?? []).includes(code)) failures.push({ path, message: `stale: ${code} is no longer missing in the module's own run` });
    }
    if (entry.unsupported) {
      if (!entry.unsupported.construct || !entry.unsupported.owedBy) failures.push({ path, message: "`unsupported` needs `construct` and `owedBy`" });
      else if (CHECK_SLICE_OWNER.test(entry.unsupported.owedBy)) failures.push({ path, message: `unsupported is owed by ${entry.unsupported.owedBy}, a completed slice` });
      if (!verdict.refused) failures.push({ path, message: "stale: `unsupported` on a manifest Rust reads whole" });
    }
    if (!(entry.codes?.length) && !entry.unsupported) failures.push({ path, message: "stale: an entry that lists nothing" });
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------
// The `load` dimension: what each kernel refuses a load with, over the `check` dimension's set.
//
// Each manifest is loaded analyze-only by both kernels under one sweep-owned `TELO_CACHE_DIR`, the
// working directory the repo root, the path as the repo writes it. Each half answers as one JSON
// object: the refusal's headline code and message, and every finding it carries — its code as
// raised, its file (the origin; none means the entry), its `path` and `resource` (the origin's;
// absent when it has none), its message and, for a finding re-reported at an import, `writtenAt`,
// where the module writing the defect reports it; the repo root's prefixes are removed. Within one
// manifest, Node's carried finding is Rust's only when all six are byte-identical.
//
// Verdicts, finding by finding:
//   - both load, or both refuse with the same headline and the same carried findings: match;
//   - Rust refuses with `ERR_UNSUPPORTED_MANIFEST_FEATURE`: passes only under the manifest's own
//     `unsupported` entry — a gap when Node loads, debt when Node refuses — and fails otherwise;
//   - Node loads and Rust refuses with anything else: fail;
//   - a finding Rust carries that Node does not: fail, whatever the debt;
//   - a finding Node carries that Rust lacks is OWED by the rule the `check` dimension judges another
//     module's finding by (`judgeOwed`), at its written place (`writtenAt`, else its own file, path and
//     resource; the file's owner found as the `check` dimension finds it, a partial mapped to its
//     owner): a listed code C passes when C, or the analyzer's `runtimeCodeOf(C)`, equals the carried
//     code — nothing maps backward. With `check` in the same sweep and no `--filter`, the module whose
//     own Node check reports the defect (by defect identity, above) owes it, and its own Rust check
//     must lack it; a defect at another module's file no module's own check reports is a context
//     finding, owed to the manifest's own entry. Under `--filter` an owner's or the manifest's entry
//     listing the code passes;
//   - the headlines may differ only when the carried findings differ and every difference is owed:
//     equal carried findings under different headlines fail, so a Node refusal carrying nothing that
//     Rust answers differently fails.

async function loadDimension() {
  const debt = readDebt();
  const covered = coveredManifests();
  const swept = covered.filter((path) => path.includes(options.filter));
  const owners = includeOwners(covered);
  const runtimeCodeOf = await loadRuntimeCodeOf();
  const confirmAgainst = !options.filter && checkAnalyses ? checkAnalyses : null;
  const lists = listsCode(debt, runtimeCodeOf);
  const cacheDir = mkdtempSync(join(tmpdir(), "rp-load-cache-"));
  const env = {
    ...process.env,
    TELO_CACHE_DIR: cacheDir,
    NO_COLOR: "1",
    PATH: [join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter),
  };
  const loaders = {};
  if (nodeCommand) loaders.node = (path) => ["bun", [join(root, ".claude", "skills", "rust-parity", "load-node.ts"), path]];
  if (rustLoader) loaders.rust = (path) => [rustLoader, [path]];
  const judging = { owners, runtimeCodeOf, confirmAgainst, lists, debt };

  const results = new Array(swept.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, swept.length) }, async () => {
      while (next < swept.length) {
        const index = next++;
        const path = swept[index];
        const result = { path };
        for (const [name, commandFor] of Object.entries(loaders)) {
          const [command, args] = commandFor(path);
          result[name] = readLoad(await runCapture(command, args, env), path);
        }
        result.verdict = result.node && result.rust ? judgeLoad(path, result, judging) : { status: "unjudged", failures: [] };
        results[index] = result;
        process.stderr.write(`load ${path}  ${result.verdict.status}\n`);
      }
    }),
  );

  const failures = results.flatMap((r) => r.verdict.failures.map((message) => ({ path: r.path, message })));
  for (const { path, message } of failures) process.stderr.write(`LOAD FAIL ${path}: ${message}\n`);
  const byStatus = (status) => results.filter((r) => r.verdict.status === status).length;
  const owed = results.flatMap((r) => r.verdict.owed ?? []);
  const summary = {
    swept: results.length,
    matched: byStatus("match"),
    debtListed: byStatus("debt"),
    gaps: byStatus("gap"),
    nodeUnusable: byStatus("node-unusable"),
    unjudged: byStatus("unjudged"),
    failed: failures.length,
    manifestsFailing: byStatus("fail"),
    owedFindings: owed.length,
    owedWrittenElsewhere: owed.filter((o) => o.writtenAt).length,
    confirmedWrittenElsewhere: owed.filter((o) => o.writtenAt && o.confirmed).length,
    confirmed: owed.filter((o) => o.confirmed).length,
    owedContext: owed.filter((o) => o.context).length,
    confirmation: confirmAgainst ? "check" : "entry alone",
  };
  return { summary, failures, results };
}

// `runtimeCodeOf` from the built analyzer: the load refusal rule's one static-to-runtime mapping.
async function loadRuntimeCodeOf() {
  if (builtRuntimeCodeOf) return builtRuntimeCodeOf;
  const built = join(root, "analyzer", "nodejs", "dist", "index.js");
  if (!existsSync(built)) fail(`${built} does not exist; build the analyzer (pnpm --filter @telorun/analyzer run build)`);
  const { runtimeCodeOf } = await import(pathToFileURL(built).href);
  if (typeof runtimeCodeOf !== "function") fail(`${built} exports no runtimeCodeOf; rebuild the analyzer`);
  builtRuntimeCodeOf = runtimeCodeOf;
  return runtimeCodeOf;
}

// One kernel's answer: `loaded`, or the refusal with the repo root's prefixes removed and each
// finding's file defaulted to the entry.
function readLoad(run, entry) {
  if (run.timedOut) return { unusable: "timed out" };
  if (run.exitCode !== 0 && run.exitCode !== 1) return { unusable: `exit ${run.exitCode}: ${tail(run.stderr)}` };
  if (run.exitCode === 0) return { loaded: true };
  let answer;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    return { unusable: `stdout is not JSON: ${tail(run.stdout)} ${tail(run.stderr)}` };
  }
  const strip = withoutRepoRoot;
  // A resource with its members in one order, so two answers compare byte for byte.
  const resourceOf = (resource) => ({
    ...(resource.kind !== undefined ? { kind: resource.kind } : {}),
    ...(resource.name !== undefined ? { name: resource.name } : {}),
  });
  const writtenAtOf = (at) => {
    if (!at || Object.keys(at).length === 0) return undefined;
    return {
      ...(at.filePath !== undefined ? { filePath: strip(at.filePath) } : {}),
      ...(at.path !== undefined ? { path: at.path } : {}),
      ...(at.resource !== undefined ? { resource: resourceOf(at.resource) } : {}),
    };
  };
  return {
    loaded: false,
    code: answer.code,
    message: strip(answer.message),
    carried: (answer.carried ?? []).map((f) => {
      const writtenAt = writtenAtOf(f.writtenAt);
      return {
        code: f.code ?? NO_CODE,
        file: f.file !== undefined ? strip(f.file) : entry,
        ...(f.path !== undefined ? { path: f.path } : {}),
        ...(f.resource !== undefined ? { resource: resourceOf(f.resource) } : {}),
        message: strip(f.message),
        ...(writtenAt ? { writtenAt } : {}),
      };
    }),
  };
}

// `text` with the repo root's prefixes — as a `file://` URL and as a path — removed.
function withoutRepoRoot(text) {
  return [`${pathToFileURL(root).href}/`, `${root}${sep}`].reduce((t, prefix) => t.split(prefix).join(""), String(text));
}

// A carried finding as Node's and Rust's are compared within one manifest: all six members.
function findingKey(f) {
  return JSON.stringify([f.code, f.file, f.path ?? null, f.resource ?? null, f.message, f.writtenAt ?? null]);
}

function judgeLoad(path, { node, rust }, judging) {
  const entry = judging.debt.manifests[path];
  if (node.unusable) return { status: "node-unusable", failures: [], note: node.unusable };
  if (rust.unusable) return { status: "fail", failures: [`Rust: ${rust.unusable}`] };
  if (node.loaded && rust.loaded) return { status: "match", failures: [] };
  if (!rust.loaded && rust.code === HOST_REFUSAL) {
    if (!entry?.unsupported) {
      return { status: "fail", failures: [`Rust holds a construct back with no \`unsupported\` entry: ${rust.message}`] };
    }
    return { status: node.loaded ? "gap" : "debt", failures: [] };
  }
  if (node.loaded) return { status: "fail", failures: [`Node loads, Rust refuses: [${rust.code}] ${rust.message}`] };

  const rustCarried = rust.loaded ? [] : rust.carried;
  const unmatched = [...rustCarried];
  const nodeOnly = [];
  for (const f of node.carried) {
    const at = unmatched.findIndex((r) => findingKey(r) === findingKey(f));
    if (at === -1) nodeOnly.push(f);
    else unmatched.splice(at, 1);
  }

  const failures = unmatched.map((f) => `Rust carries what Node does not: ${JSON.stringify(f)}`);
  const owed = [];
  for (const f of nodeOnly) {
    const owing = oweLoadFinding(f, path, judging);
    if (owing.failure) failures.push(owing.failure);
    else owed.push(owing.owed);
  }
  const sameHeadline = !rust.loaded && rust.code === node.code && rust.message === node.message;
  if (!nodeOnly.length && !unmatched.length && !sameHeadline) {
    const rustHeadline = rust.loaded ? "(loads)" : `[${rust.code}] ${rust.message}`;
    failures.push(
      node.carried.length
        ? `the carried findings agree, the headlines differ: Node [${node.code}] ${node.message}; Rust ${rustHeadline}`
        : `Node refuses carrying nothing, Rust answers differently: Node [${node.code}] ${node.message}; Rust ${rustHeadline}`,
    );
  }
  if (failures.length) return { status: "fail", failures, owed };
  return { status: nodeOnly.length ? "debt" : "match", failures: [], owed };
}

// The module a finding Node carries and Rust lacks is owed by, judged at its written place.
function oweLoadFinding(f, entry, { owners, runtimeCodeOf, confirmAgainst, lists }) {
  const at = loadPlace(f, entry);
  const judged = judgeOwed({ code: f.code, at, entry, owners: owners.get(at.file) ?? [], lists, runtimeCodeOf, confirm: confirmAgainst });
  if (judged.failure) {
    const where = [f.file, f.path, resourceText(f.resource)].filter((part) => part !== undefined).join(" ");
    const written = f.writtenAt ? ` (written at ${JSON.stringify(f.writtenAt)})` : "";
    return { failure: `Rust lacks ${f.code} ${where}${written}: ${f.message} — ${judged.failure}` };
  }
  return {
    owed: {
      code: f.code,
      owners: judged.owners,
      writtenAt: Boolean(f.writtenAt),
      confirmed: judged.confirmed,
      ...(judged.context ? { context: true } : {}),
    },
  };
}

function parseArgs(argv) {
  const parsed = {
    out: null,
    filter: "",
    only: null,
    concurrency: 3,
    timeout: 600,
    dimensions: [],
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
    else if (flag === "--dimension" && value.split(",").every((d) => ["run", "check", "load"].includes(d))) {
      for (const d of value.split(",")) if (!parsed.dimensions.includes(d)) parsed.dimensions.push(d);
    }
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
