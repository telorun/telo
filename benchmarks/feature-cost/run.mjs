#!/usr/bin/env node
// Generates the feature-cost applications and measures each feature's boot and check time per
// size through Benchmark.Comparison. Usage: node run.mjs --help

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { comparisonManifest, kebab } from "./comparison-manifest.mjs";
import { FEATURES, SIZE_CLASSES } from "./features.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: node benchmarks/feature-cost/run.mjs [options]

Generates plain applications under <dir> and measures each feature at each size.

  --features <a,b>        Features to run (default: all). --list prints them.
  --sizes <1,2,4>         Sizes for every selected feature (default: each feature's class).
  --rounds <n>            Comparison rounds per size (default: 5).
  --boot-timeout <dur>    Per-boot limit, e.g. 60s (default: 60s).
  --out <file>            The feature-cost.jsonl written, one line per feature
                          (default: <dir>/feature-cost.jsonl). Overwritten.
  --dir <dir>             Where manifests and reports go (default: ./generated).
  --commit <sha>          Commit recorded on each line (default: $COMMIT, else git HEAD).
  --features-module <js>  An ES module exporting FEATURES, added to the catalogue.
  --generate-only         Write the applications and stop.
  --check                 Generate, run \`telo check\` on each, exit non-zero on any finding.
  --list                  Print the feature names and stop.

Standard output carries the same lines as --out; progress goes to standard error.

Environment: TELO_COMMAND is the telo command (default: telo), used for the comparisons and
for the subjects they time. The measuring path needs Linux, taskset and 2+ physical cores.`;

const { values: opts } = parseArgs({
  options: {
    features: { type: "string" },
    sizes: { type: "string" },
    rounds: { type: "string", default: "5" },
    "boot-timeout": { type: "string", default: "60s" },
    out: { type: "string" },
    dir: { type: "string", default: join(here, "generated") },
    commit: { type: "string" },
    "features-module": { type: "string" },
    "generate-only": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const catalogue = [...FEATURES];
if (opts["features-module"]) {
  const extra = await import(pathToFileURL(resolve(opts["features-module"])).href);
  catalogue.push(...extra.FEATURES);
}

if (opts.list) {
  console.log(catalogue.map((f) => f.name).join("\n"));
  process.exit(0);
}

const fail = (message) => {
  console.error(`feature-cost: ${message}`);
  process.exit(2);
};

const selected = opts.features
  ? opts.features.split(",").map((name) => catalogue.find((f) => f.name === name) ?? fail(`unknown feature "${name}"`))
  : catalogue;
const sizeOverride = opts.sizes?.split(",").map((s) => (Number.isInteger(Number(s)) && Number(s) > 0 ? Number(s) : fail(`bad size "${s}"`)));
const sizesOf = (feature) => sizeOverride ?? SIZE_CLASSES[feature.sizes];
const teloCommand = (process.env.TELO_COMMAND ?? "telo").trim().split(/\s+/);
const dir = resolve(opts.dir);
const outFile = resolve(opts.out ?? join(dir, "feature-cost.jsonl"));

// The comparison manifests import the module by a path relative to `benchmarks/feature-cost/generated`.
if (dir !== join(here, "generated")) fail("--dir must be benchmarks/feature-cost/generated: generated manifests import the repository's modules by relative path");

function generate(feature, n) {
  const slug = `${kebab(feature.name)}-${n}`;
  const appDir = join(dir, slug);
  rmSync(appDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(feature.generate(n))) {
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), content);
  }
  const comparison = join(dir, `${slug}.comparison.yaml`);
  writeFileSync(
    comparison,
    comparisonManifest({ feature: feature.name, n, rounds: Number(opts.rounds), bootTimeout: opts["boot-timeout"], teloCommand }),
  );
  return { slug, appDir, comparison, report: join(dir, `${slug}.json`) };
}

function telo(args, env = {}) {
  const [program, ...prefix] = teloCommand;
  return new Promise((done) => {
    const child = spawn(program, [...prefix, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

mkdirSync(dir, { recursive: true });

if (opts.check || opts["generate-only"]) {
  let broken = 0;
  for (const feature of selected) {
    for (const n of sizesOf(feature)) {
      const { appDir } = generate(feature, n);
      if (!opts.check) continue;
      const result = await telo(["check", join(appDir, "telo.yaml")]);
      if (result.code !== 0) {
        broken++;
        console.error(`${feature.name} n=${n}: telo check exited ${result.code}\n${result.stdout}${result.stderr}`);
      } else console.error(`${feature.name} n=${n}: clean`);
    }
  }
  process.exit(broken === 0 ? 0 : 1);
}

// "<path>  error  <message>  <CODE>" is how `telo run` prints a refusal.
function refusalOf(stderr) {
  for (const line of stderr.split("\n")) {
    const match = /\serror {2}(.*) {2}(ERR_[A-Z0-9_]+)$/.exec(line.trimEnd());
    if (match) return { code: match[2], message: match[1].replace(/^Benchmark\.Comparison "[^"]*": /, "") };
  }
  return null;
}

// Failures of the feature at this size; anything else (a missing platform, a crashed run) is
// the sweep's own and ends it rather than being recorded as a limit of the feature.
const FEATURE_FAILURES = new Set(["ERR_BENCHMARK_BOOT_FAILED", "ERR_BENCHMARK_STARTUP_SPAN_MISSING"]);

const commit =
  opts.commit ??
  process.env.COMMIT ??
  (() => {
    const r = spawnSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: here, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  })();

const timing = (record, subject, key) => record.bootResults.find((b) => b.subject === subject)?.[key];

const lines = [];
let context = { teloVersion: null, host: null };
const write = () => writeFileSync(outFile, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));

try {
  for (const feature of selected) {
    const entry = { feature: feature.name, sizes: [] };
    for (const n of sizesOf(feature)) {
      const { comparison, report, appDir } = generate(feature, n);
      rmSync(report, { force: true });
      console.error(`feature-cost: ${feature.name} n=${n}`);
      const result = await telo(["run", comparison], { REPORT_FILE: report });
      if (result.code === 0 && existsSync(report)) {
        const record = JSON.parse(readFileSync(report, "utf8").trim().split("\n").pop());
        context = { teloVersion: record.teloVersion, host: record.host };
        entry.sizes.push({
          n,
          runColdMs: timing(record, "run", "coldMs"),
          runWarmMs: timing(record, "run", "warmMs"),
          startupMs: timing(record, "run", "startupMs"),
          checkColdMs: timing(record, "check", "coldMs"),
          checkWarmMs: timing(record, "check", "warmMs"),
        });
        rmSync(appDir, { recursive: true, force: true });
        continue;
      }
      const refusal = refusalOf(result.stderr);
      if (!refusal || !FEATURE_FAILURES.has(refusal.code)) {
        throw new Error(`the comparison for ${feature.name} n=${n} exited ${result.code}:\n${result.stdout}${result.stderr}`);
      }
      entry.firstFailure = { n, ...refusal };
      console.error(`feature-cost: ${feature.name} stops at n=${n}: ${refusal.code}`);
      break;
    }
    lines.push(entry);
  }
} finally {
  const finished = lines.map((l) => ({ commit, teloVersion: context.teloVersion, host: context.host, ...l }));
  lines.splice(0, lines.length, ...finished);
  write();
}
for (const line of lines) console.log(JSON.stringify(line));
console.error(`feature-cost: wrote ${lines.length} lines to ${outFile}`);
