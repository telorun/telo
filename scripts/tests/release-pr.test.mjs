// The release PR's version command, its candidacy and its body. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ACTION_HEADROOM, BODY_LIMIT, composeReleasePrBody, documentBudget } from "../release-pr-body.mjs";
import { versionReleasePr } from "../release-pr-version.mjs";
import { branchRecordsFinal, headCarriesFinal, isCandidate, versionPrBranch } from "../release-version.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ledger(units) {
  const lines = ["units:"];
  for (const [key, entry] of Object.entries(units)) {
    lines.push(`  ${key}:`);
    if (entry.version) lines.push(`    version: ${entry.version}`);
    if (entry.candidate) lines.push("    candidate:", `      version: ${entry.candidate}`);
  }
  return lines.join("\n") + "\n";
}

/** A repository with `release/0.85` and its release PR head as remote refs: the
 *  head's ledger writes `head`, over the branch's `base`. */
function releaseRepo({ base, head, tags = [] }) {
  const root = mkdtempSync(join(tmpdir(), "telo-release-version-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, ".changes"));
  writeFileSync(join(root, ".changes", "ledger.yaml"), ledger(base));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/release/0.85", "HEAD");
  for (const tag of tags) git(root, "tag", tag);
  writeFileSync(join(root, ".changes", "ledger.yaml"), ledger(head));
  git(root, "commit", "-q", "-am", "chore(release): version");
  git(root, "update-ref", `refs/remotes/origin/${versionPrBranch("release/0.85")}`, "HEAD");
  return root;
}

describe("release PR candidacy", () => {
  it("is in candidates while v<x.y>.0 is absent and no open release PR carries final versions", () => {
    const root = releaseRepo({ base: { kernel: { version: "0.84.2" } }, head: { kernel: { version: "0.84.2", candidate: "0.85.0-rc.1" } } });
    assert.equal(versionPrBranch("release/0.85"), "release-version/release/0.85");
    assert.equal(headCarriesFinal({ cwd: root, branch: "release/0.85" }), false);
    assert.equal(isCandidate({ cwd: root, branch: "release/0.85" }), true);
    assert.equal(isCandidate({ cwd: root, branch: "release/0.85", openPr: true, carriesFinal: () => false }), true);
    assert.equal(isCandidate({ cwd: root, branch: "release/0.85", final: true }), false);
  });

  it("is final once the open release PR's head records a final version, or once v<x.y>.0 exists", () => {
    const going = releaseRepo({ base: { kernel: { version: "0.84.2" } }, head: { kernel: { version: "0.85.0" } } });
    assert.equal(headCarriesFinal({ cwd: going, branch: "release/0.85" }), true);
    assert.equal(isCandidate({ cwd: going, branch: "release/0.85", openPr: true, carriesFinal: () => true }), false);
    assert.equal(isCandidate({ cwd: going, branch: "release/0.85", openPr: false }), true);

    const patching = releaseRepo({ base: { kernel: { version: "0.85.0" } }, head: { kernel: { version: "0.85.1" } }, tags: ["v0.85.0"] });
    assert.equal(isCandidate({ cwd: patching, branch: "release/0.85" }), false);
  });

  it("is final once the branch records its line's final, before v<x.y>.0 exists", () => {
    const merged = releaseRepo({ base: { analyzer: { version: "0.85.0" } }, head: { analyzer: { version: "0.85.0", candidate: "0.85.1-rc.1" } } });
    assert.equal(branchRecordsFinal({ cwd: merged, branch: "release/0.85" }), true);
    assert.equal(isCandidate({ cwd: merged, branch: "release/0.85" }), false);

    const previousLine = releaseRepo({ base: { analyzer: { version: "0.84.2", candidate: "0.85.0-rc.2" } }, head: { analyzer: { version: "0.84.2" } } });
    assert.equal(branchRecordsFinal({ cwd: previousLine, branch: "release/0.85" }), false);
    assert.equal(isCandidate({ cwd: previousLine, branch: "release/0.85" }), true);
  });
});

describe("release PR version command", () => {
  const ran = (candidate, maxLength = 64_000) => {
    const commands = [];
    versionReleasePr({
      cwd: "/repo",
      candidate,
      notesFile: "/notes.md",
      maxLength,
      run: (command, args, { stdoutFile } = {}) =>
        commands.push([command === process.execPath ? "node" : command, ...args].join(" ") + (stdoutFile ? " > notes" : "")),
    });
    return commands;
  };

  it("applies the plan, a candidate's with --candidate, printing its document within the budget for the body", () => {
    assert.deepEqual(ran(false), ["node ./cli/nodejs/bin/telo.mjs release apply --base HEAD -o markdown --max-length 64000 > notes"]);
    assert.deepEqual(ran(true), [
      "node ./cli/nodejs/bin/telo.mjs release apply --base HEAD --candidate -o markdown --max-length 64000 > notes",
    ]);
    assert.throws(() => ran(false, Number.NaN), /need a length limit/);
  });
});

describe("release PR body", () => {
  it("leads with the workflow's lines, then candidate or final and the pointer to the diff, then the document", () => {
    assert.equal(
      composeReleasePrBody({ candidate: false, preamble: "Publishes `0.85.0`.\n", document: "## `kernel` 0.84.2 → 0.85.0\n" }),
      "Publishes `0.85.0`.\n\nMerging this publishes the **finals** below. Each unit's version, its CHANGELOG and " +
        "`.changes/ledger.yaml` are in this PR's diff.\n\n## `kernel` 0.84.2 → 0.85.0\n",
    );
    assert.match(composeReleasePrBody({ candidate: true, document: "x\n" }), /^Merging this publishes the \*\*candidates\*\*/);
  });

  it("budgets the document to what GitHub's body limit leaves, so the whole body fits", () => {
    for (const head of [{ candidate: false }, { candidate: true, preamble: "Publishes `0.85.0` — “final”.\n\nAnd more.\n" }]) {
      const budget = documentBudget(head);
      const body = composeReleasePrBody({ ...head, document: "é".repeat(budget) });
      assert.equal([...body].length, BODY_LIMIT - ACTION_HEADROOM);
    }
  });
});
