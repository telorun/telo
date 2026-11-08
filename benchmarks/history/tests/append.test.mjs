// Runs append.mjs against a temporary local bare repository: no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../append.mjs");
const scratch = mkdtempSync(join(tmpdir(), "history-test-"));
const bare = join(scratch, "remote.git");
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (args, cwd = scratch) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

const append = (records, target) => {
  const file = join(scratch, "records.jsonl");
  writeFileSync(file, records);
  return spawnSync(process.execPath, [script, "--records", file, "--target", target, "--remote", bare], { cwd: scratch, encoding: "utf8" });
};

before(() => git(["init", "--bare", "--quiet", bare]));

test("creates the orphan branch on the first append and adds to the file on the next", () => {
  assert.equal(append('{"run":1}\n{"run":2}\n', "authoring.jsonl").status, 0);
  assert.equal(git(["rev-list", "--count", "benchmark-results"], bare), "1");
  assert.equal(git(["rev-list", "--max-parents=0", "benchmark-results"], bare), git(["rev-parse", "benchmark-results"], bare));
  assert.equal(git(["show", "benchmark-results:authoring.jsonl"], bare), '{"run":1}\n{"run":2}');

  assert.equal(append('{"run":3}', "authoring.jsonl").status, 0);
  assert.equal(append('{"feature":"x"}\n', "feature-cost.jsonl").status, 0);
  assert.equal(git(["show", "benchmark-results:authoring.jsonl"], bare), '{"run":1}\n{"run":2}\n{"run":3}');
  assert.equal(git(["show", "benchmark-results:feature-cost.jsonl"], bare), '{"feature":"x"}');
  assert.equal(git(["rev-list", "--count", "benchmark-results"], bare), "3");
  assert.equal(git(["log", "-1", "--format=%an", "benchmark-results"], bare), "github-actions[bot]");
});

test("refuses a line that is not a JSON object and pushes nothing", () => {
  const before = git(["rev-parse", "benchmark-results"], bare);
  const run = append('{"run":4}\nnot json\n', "authoring.jsonl");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /line 2 is not JSON/);
  assert.equal(git(["rev-parse", "benchmark-results"], bare), before);
});

test("refuses a target that is not a bare .jsonl name", () => {
  const run = append('{"run":5}\n', "../escape.jsonl");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /bare file name/);
});
