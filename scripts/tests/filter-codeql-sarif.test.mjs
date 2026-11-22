// filter-codeql-sarif: which results a suppression comment drops and which comments fail the job.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { filterSarifs, parseSuppressions, run } from "../filter-codeql-sarif.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Built by concatenation so this file holds no comment of its own in the spelling.
const mark = (rule, reason = "") => `// ${"codeql"}[${rule}]${reason === "" ? "" : ` ${reason}`}`;

const result = (ruleId, uri, startLine) => ({
  ruleId,
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
});

describe("parseSuppressions", () => {
  it("reads a comment with its rule and reason, in // and # spellings", () => {
    const text = `${mark("js/reflected-xss", "escaped upstream")}\nsink();\n# ${"codeql"}[actions/untrusted-checkout] pinned ref\n`;
    assert.deepEqual(parseSuppressions("a.ts", text).comments, [
      { file: "a.ts", line: 1, rule: "js/reflected-xss" },
      { file: "a.ts", line: 3, rule: "actions/untrusted-checkout" },
    ]);
  });

  it("refuses a missing reason, several rules and a wildcard", () => {
    const { comments, problems } = parseSuppressions(
      "a.ts",
      [mark("js/reflected-xss"), mark("js/a, js/b", "why"), mark("js/*", "why")].join("\n"),
    );
    assert.deepEqual(comments, []);
    assert.match(problems[0], /^a\.ts:1: .*no reason/);
    assert.match(problems[1], /^a\.ts:2: .*exactly one rule/);
    assert.match(problems[2], /^a\.ts:3: .*wildcard/);
    assert.equal(problems.length, 3);
  });
});

describe("filterSarifs", () => {
  const comments = [{ file: "src/a.ts", line: 4, rule: "js/reflected-xss" }];

  it("drops the result on the line below its comment and keeps the rest", () => {
    const doc = {
      runs: [{ results: [result("js/reflected-xss", "src/a.ts", 5), result("js/reflected-xss", "src/a.ts", 9), result("js/sql-injection", "src/a.ts", 5)] }],
    };
    const stale = filterSarifs([doc], comments, "javascript-typescript");
    assert.deepEqual(stale, []);
    assert.deepEqual(doc.runs[0].results.map((r) => [r.ruleId, r.locations[0].physicalLocation.region.startLine]), [
      ["js/reflected-xss", 9],
      ["js/sql-injection", 5],
    ]);
  });

  it("reports a comment that suppresses nothing, only for the run's own language", () => {
    const doc = { runs: [{ results: [] }] };
    assert.deepEqual(filterSarifs([doc], comments, "javascript-typescript"), comments);
    assert.deepEqual(filterSarifs([doc], comments, "rust"), []);
  });
});

describe("run", () => {
  function tree(source, results) {
    const root = mkdtempSync(join(tmpdir(), "filter-codeql-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), source);
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    const sarif = join(root, "out.sarif");
    writeFileSync(sarif, JSON.stringify({ runs: [{ results }] }));
    return { root, sarif };
  }

  it("rewrites the SARIF without the suppressed result", () => {
    const { root, sarif } = tree(`${mark("js/reflected-xss", "why")}\nsink();\n`, [result("js/reflected-xss", "a.ts", 2), result("js/other", "a.ts", 2)]);
    const outcome = run({ root, language: "javascript-typescript", target: sarif });
    assert.deepEqual(outcome, { errors: [], dropped: 1 });
    assert.deepEqual(JSON.parse(readFileSync(sarif, "utf8")).runs[0].results.map((r) => r.ruleId), ["js/other"]);
  });

  it("fails naming file:line on a stale comment and leaves the SARIF untouched", () => {
    const { root, sarif } = tree(`${mark("js/reflected-xss", "why")}\nsink();\n`, []);
    const { errors } = run({ root, language: "javascript-typescript", target: sarif });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^a\.ts:1: /);
  });

  it("does not judge staleness when told to skip it, and still drops what a comment suppresses", () => {
    const { root, sarif } = tree(`${mark("js/reflected-xss", "why")}\nsink();\n${mark("js/other", "why")}\nsink();\n`, [result("js/other", "a.ts", 4)]);
    assert.deepEqual(run({ root, language: "javascript-typescript", target: sarif, judgeStale: false }), { errors: [], dropped: 1 });
  });
});
