#!/usr/bin/env node
// The authoring benchmark's harness. Commands: run (default), summary, compare. Usage: node run.mjs --help

import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { appLauncher, assertContractsReadable, runContract, teloCommand } from "./app-launcher.mjs";
import { attemptDirectory, runAttempt } from "./attempt.mjs";
import { writeComparison } from "./comparison-generation.mjs";
import { buildImage, dockerAgent } from "./docker-agent.mjs";
import { renderSummary, summarize } from "./summary.mjs";
import { SIDES, TASKS, repoRoot } from "./tasks.mjs";
import { prepareWorkspace } from "./workspace.mjs";

const HELP = `Usage: node benchmarks/authoring/run.mjs [run|summary|compare] [options]

run      Runs the attempts: for each task and side, --attempts times, one at a time. Each attempt
         runs Claude Code in a fresh container, then boots the built app and runs the contract
         tests. Appends one line per attempt to <out>/records/<task>-<side>.jsonl.
summary  Reads every <out>/records/*.jsonl, writes <out>/authoring.jsonl (the lines the history
         script appends) and <out>/summary.md, and prints the report.
compare  Generates a Benchmark.Comparison over the first passing build attempt of each side
         under <out>/comparison/, and with --run, runs it (Linux, taskset, 2+ cores).

Options:
  --tasks <a,b>              Tasks (default: all of ${Object.keys(TASKS).join(", ")}).
  --sides <telo,node>        Sides (default: both).
  --attempts <n>             Attempts per side per task (default: 5).
  --model <name>             The pinned model (default: claude-opus-5-5).
  --out <dir>                Where attempts, records and reports go (default: <tmpdir>/telo-authoring).
  --telo-version <v>         The published telo CLI under test; recorded (default: $TELO_VERSION).
  --commit <sha>             Commit recorded (default: $COMMIT, else git HEAD).
  --timeout-minutes <n>      An attempt past this counts as failed (default: 60).
  --max-budget-usd <n>       An attempt past this counts as failed (default: 20).
  --build-images             Build the container images first (the telo image installs the CLI at
                             --telo-version and carries the primer and the hub MCP config).
  --image-prefix <name>      Image name prefix (default: telo-authoring).
  --claude-code-version <v>  @anthropic-ai/claude-code version in the images.
  --hub-mcp-url <url>        The hub's MCP endpoint for the telo side (default: https://telo.sh/mcp).
  --forward-env <NAME>       Variable docker copies into the container by name; repeatable
                             (default: ANTHROPIC_API_KEY).
  --run                      compare: also run the generated comparison.

Environment: TELO_COMMAND is the telo command that runs the contract tests and the Telo app
(default: telo). The agent's container needs docker.`;

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    tasks: { type: "string" },
    sides: { type: "string" },
    attempts: { type: "string", default: "5" },
    model: { type: "string", default: "claude-opus-5-5" },
    out: { type: "string", default: join(tmpdir(), "telo-authoring") },
    "telo-version": { type: "string" },
    commit: { type: "string" },
    "timeout-minutes": { type: "string", default: "60" },
    "max-budget-usd": { type: "string", default: "20" },
    "build-images": { type: "boolean", default: false },
    "image-prefix": { type: "string", default: "telo-authoring" },
    "claude-code-version": { type: "string" },
    "hub-mcp-url": { type: "string", default: "https://telo.sh/mcp" },
    "forward-env": { type: "string", multiple: true },
    run: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const fail = (message) => {
  console.error(`authoring: ${message}`);
  process.exit(2);
};

const list = (text, allowed, what) =>
  text ? text.split(",").map((item) => (allowed.includes(item) ? item : fail(`unknown ${what} "${item}"`))) : allowed;
const positiveNumber = (text, what) => (Number(text) > 0 ? Number(text) : fail(`${what} must be a positive number, got "${text}"`));

const recordsDirectory = join(opts.out, "records");

function readRecords() {
  if (!existsSync(recordsDirectory)) fail(`no records under ${recordsDirectory}`);
  return readdirSync(recordsDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(recordsDirectory, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line)),
    );
}

function commitSha() {
  if (opts.commit ?? process.env.COMMIT) return opts.commit ?? process.env.COMMIT;
  const head = spawnSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  if (head.status !== 0) fail("cannot read the commit: pass --commit or set $COMMIT");
  return head.stdout.trim();
}

async function runCommand() {
  const tasks = list(opts.tasks, Object.keys(TASKS), "task");
  const sides = list(opts.sides, SIDES, "side");
  const attempts = positiveNumber(opts.attempts, "--attempts");
  const teloVersion = opts["telo-version"] ?? process.env.TELO_VERSION ?? fail("pass --telo-version or set $TELO_VERSION");
  const commit = commitSha();
  const forwardEnv = opts["forward-env"] ?? ["ANTHROPIC_API_KEY"];

  if (opts["build-images"]) {
    for (const side of sides) {
      buildImage({
        side,
        prefix: opts["image-prefix"],
        teloVersion,
        claudeCodeVersion: opts["claude-code-version"],
        hubMcpUrl: opts["hub-mcp-url"],
      });
    }
  }

  try {
    assertContractsReadable(tasks);
  } catch (error) {
    fail(error.message);
  }

  // A starter that does not check is a setup fault (say, a module not yet published), not a failed attempt.
  if (sides.includes("telo")) {
    for (const task of tasks.filter((name) => TASKS[name].change)) {
      const starter = join(opts.out, "starters", task);
      rmSync(starter, { recursive: true, force: true });
      prepareWorkspace(task, "telo", starter);
      const [command, ...args] = teloCommand();
      const check = spawnSync(command, [...args, "check", "telo.yaml"], { cwd: starter, encoding: "utf8" });
      if (check.status !== 0) fail(`the Telo starter of ${task} does not check:\n${check.stdout}${check.stderr}`);
    }
  }

  const seams = { agent: dockerAgent({ prefix: opts["image-prefix"], forwardEnv }), launcher: appLauncher, contract: runContract };
  mkdirSync(recordsDirectory, { recursive: true });
  for (const task of tasks) {
    for (const side of sides) {
      const recordsFile = join(recordsDirectory, `${task}-${side}.jsonl`);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        rmSync(attemptDirectory(opts.out, task, side, attempt), { recursive: true, force: true });
        console.error(`authoring: ${task} / ${side} / attempt ${attempt} of ${attempts}`);
        const record = await runAttempt(
          {
            task,
            side,
            attempt,
            commit,
            teloVersion,
            model: opts.model,
            outDir: opts.out,
            timeoutMs: positiveNumber(opts["timeout-minutes"], "--timeout-minutes") * 60_000,
            maxBudgetUsd: positiveNumber(opts["max-budget-usd"], "--max-budget-usd"),
          },
          seams,
        );
        appendFileSync(recordsFile, `${JSON.stringify(record)}\n`);
        console.error(`authoring:   ${record.contractTestsPassed ? "passed" : "failed"}, ${record.turns} turns, ${record.wallSeconds}s, $${record.costUsd ?? "?"}`);
      }
    }
  }
}

function summaryCommand() {
  const records = readRecords();
  const report = renderSummary(summarize(records));
  writeFileSync(join(opts.out, "authoring.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  writeFileSync(join(opts.out, "summary.md"), `${report}\n`);
  console.log(report);
}

function compareCommand() {
  const records = readRecords();
  const directory = join(opts.out, "comparison");
  rmSync(directory, { recursive: true, force: true });
  const sides = [];
  for (const side of SIDES) {
    const built = records.filter((r) => r.task === "build" && r.side === side && r.contractTestsPassed).sort((a, b) => a.attempt - b.attempt)[0];
    if (!built) {
      console.error(`authoring: no passing build attempt on the ${side} side; it is left out of the comparison`);
      continue;
    }
    const app = join(directory, "built", side);
    cpSync(join(attemptDirectory(opts.out, "build", side, built.attempt), "workspace"), app, {
      recursive: true,
      filter: (source) => !/(^|[\\/])(node_modules|\.telo)$/.test(source),
    });
    appLauncher.prepare(app, side);
    sides.push(side);
  }
  if (sides.length === 0) fail("no side has a passing build attempt");
  const manifest = writeComparison({ directory, sides });
  console.error(`authoring: wrote ${manifest}`);
  if (!opts.run) return;
  const [command, ...args] = teloCommand();
  const run = spawnSync(command, [...args, "run", manifest], {
    stdio: "inherit",
    env: { ...process.env, REPORT_FILE: join(directory, "comparison.json") },
  });
  process.exit(run.status ?? 1);
}

const command = positionals[0] ?? "run";
if (command === "run") await runCommand();
else if (command === "summary") summaryCommand();
else if (command === "compare") compareCommand();
else fail(`unknown command "${command}"; --help lists them`);
