#!/usr/bin/env node
// Appends a file of JSON-lines records to a file on the orphan branch that holds the benchmark
// history, creating the branch when it is absent. Usage: node append.mjs --help

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: node benchmarks/history/append.mjs --records <file> --target <name>.jsonl [options]

Appends every line of <file> (one JSON object per line) to <name>.jsonl on the history branch,
commits and pushes. The branch is created as an orphan when the remote has none. A push that
loses a race is retried against the new tip, up to 3 attempts.

  --records <file>       The lines to append (required, at least one).
  --target <name>.jsonl  The file on the branch, a bare file name (required).
  --branch <name>        History branch (default: benchmark-results).
  --remote <url>         Where to fetch from and push to (default: this repository's origin).
  --message <text>       Commit message (default: "Append <n> record(s) to <target>").
  --author-name <name>   Commit identity (default: github-actions[bot]).
  --author-email <addr>  Commit identity (default: 41898282+github-actions[bot]@users.noreply.github.com).

For an https remote, $GITHUB_TOKEN, when set, authenticates fetch and push (the workflow token
needs contents: write). The token is passed to git as configuration, never written into a URL.`;

const { values: opts } = parseArgs({
  options: {
    records: { type: "string" },
    target: { type: "string" },
    branch: { type: "string", default: "benchmark-results" },
    remote: { type: "string" },
    message: { type: "string" },
    "author-name": { type: "string", default: "github-actions[bot]" },
    "author-email": { type: "string", default: "41898282+github-actions[bot]@users.noreply.github.com" },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const fail = (message) => {
  console.error(`history: ${message}`);
  process.exit(1);
};

if (!opts.records) fail("--records is required");
if (!opts.target) fail("--target is required");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(opts.target)) fail(`--target must be a bare file name ending in .jsonl, got "${opts.target}"`);
if (!existsSync(opts.records)) fail(`no records file at ${opts.records}`);

const lines = readFileSync(opts.records, "utf8").split("\n").filter((line) => line.trim() !== "");
if (lines.length === 0) fail(`${opts.records} holds no records`);
lines.forEach((line, index) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(`${opts.records} line ${index + 1} is not JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${opts.records} line ${index + 1} is not a JSON object`);
});

function git(directory, args, { config = [], allowFailure = false } = {}) {
  const run = spawnSync("git", [...config.flatMap((c) => ["-c", c]), ...args], { cwd: directory, encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed (exit ${run.status}): ${run.stderr.trim()}`);
  return run;
}

const remote = opts.remote ?? git(process.cwd(), ["remote", "get-url", "origin"]).stdout.trim();
const auth = [];
if (process.env.GITHUB_TOKEN && /^https:\/\//.test(remote)) {
  const origin = `${new URL(remote).origin}/`;
  const credentials = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
  auth.push(`http.${origin}.extraheader=Authorization: basic ${credentials}`);
}

function appendOnce() {
  const work = mkdtempSync(join(tmpdir(), "benchmark-history-"));
  try {
    git(work, ["init", "--quiet"]);
    git(work, ["remote", "add", "origin", remote]);
    const listing = git(work, ["ls-remote", "--exit-code", "--heads", "origin", opts.branch], { config: auth, allowFailure: true });
    if (listing.status === 0) {
      git(work, ["fetch", "--quiet", "--depth", "1", "origin", opts.branch], { config: auth });
      git(work, ["checkout", "--quiet", "-B", opts.branch, "FETCH_HEAD"]);
    } else if (listing.status === 2) {
      git(work, ["checkout", "--quiet", "--orphan", opts.branch]);
    } else {
      throw new Error(`git ls-remote failed (exit ${listing.status}): ${listing.stderr.trim()}`);
    }
    const file = join(work, opts.target);
    if (existsSync(file) && !readFileSync(file, "utf8").endsWith("\n")) appendFileSync(file, "\n");
    appendFileSync(file, lines.map((line) => `${line}\n`).join(""));
    git(work, ["add", opts.target]);
    const message = opts.message ?? `Append ${lines.length} record${lines.length === 1 ? "" : "s"} to ${opts.target}`;
    git(work, ["commit", "--quiet", "--message", message], {
      config: [`user.name=${opts["author-name"]}`, `user.email=${opts["author-email"]}`],
    });
    return git(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${opts.branch}`], { config: auth, allowFailure: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const ATTEMPTS = 3;
for (let attempt = 1; ; attempt++) {
  const push = appendOnce();
  if (push.status === 0) break;
  if (attempt === ATTEMPTS) fail(`the push to ${opts.branch} failed ${ATTEMPTS} times. Last error: ${push.stderr.trim()}`);
  console.error(`history: push rejected (attempt ${attempt} of ${ATTEMPTS}); retrying against the new tip`);
}
console.log(`history: appended ${lines.length} record${lines.length === 1 ? "" : "s"} to ${opts.target} on ${opts.branch}`);
