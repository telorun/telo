#!/usr/bin/env node
// Runs every manifest test `test-suite.yaml` discovers on both kernels and writes one verdict per
// test per kernel. Run from a repo root: `node .claude/skills/rust-parity/sweep.mjs --out <file>
// [--filter <text>] [--only rust|node] [--concurrency <n>] [--timeout <seconds>]`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const root = process.cwd();
const suitePath = join(root, "test-suite.yaml");
if (!existsSync(suitePath)) fail(`no test-suite.yaml in ${root}; run from the repo root`);

const YAML = createRequire(join(root, "package.json"))("yaml");
const suiteVariables = YAML.parseAllDocuments(readFileSync(suitePath, "utf8"), {
  logLevel: "silent",
})[0].toJS().variables;
const include = suiteVariables.include.default;
const exclude = suiteVariables.exclude.default;

const tests = globSync(include, { cwd: root, exclude })
  .filter((path) => path.includes(options.filter))
  .sort();

const kernels = {};
if (options.only !== "rust") {
  const [command, ...args] = readPackageScript("telo").split(/\s+/);
  kernels.node = (test) => [command, [...args, test]];
}
if (options.only !== "node") {
  const build = spawnSync("cargo", ["build", "--release", "--locked", "-p", "telo-cli"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.status !== 0) fail(`cargo build of telo-cli failed (exit ${build.status})`);
  const binary = join(root, "target", "release", process.platform === "win32" ? "telo.exe" : "telo");
  kernels.rust = (test) => [binary, ["run", test]];
}

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

mkdirSync(dirname(resolve(options.out)), { recursive: true });
writeFileSync(
  options.out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
      filter: options.filter,
      summary,
      results,
    },
    null,
    2,
  ),
);
process.stdout.write(`${JSON.stringify(summary)}\n`);

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
// overridden by the host environment.
function envForManifest(test) {
  const dir = dirname(join(root, test));
  return { ...readEnvFile(join(dir, ".env")), ...readEnvFile(join(dir, ".env.local")), ...process.env };
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

function parseArgs(argv) {
  const parsed = { out: null, filter: "", only: null, concurrency: 3, timeout: 600 };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) fail(`${flag} needs a value`);
    if (flag === "--out") parsed.out = value;
    else if (flag === "--filter") parsed.filter = value;
    else if (flag === "--only" && (value === "rust" || value === "node")) parsed.only = value;
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
