// The release PR's version command, its candidacy and its body. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { composeReleasePrBody } from "../release-pr-body.mjs";
import { versionReleasePr } from "../release-pr-version.mjs";
import { headCarriesFinal, isCandidate, versionPrBranch } from "../release-version.mjs";

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
});

describe("release PR version command", () => {
  const ran = (candidate) => {
    const commands = [];
    versionReleasePr({
      cwd: "/repo",
      candidate,
      planFile: "/plan.json",
      run: (command, args, { stdoutFile } = {}) =>
        commands.push([command === process.execPath ? "node" : command, ...args].join(" ") + (stdoutFile ? " > plan" : "")),
    });
    return commands;
  };

  it("applies the plan, a candidate's with --candidate, printing it for the body", () => {
    assert.deepEqual(ran(false), ["node ./cli/nodejs/bin/telo.mjs release apply --base HEAD -o json > plan"]);
    assert.deepEqual(ran(true), ["node ./cli/nodejs/bin/telo.mjs release apply --base HEAD --candidate -o json > plan"]);
  });
});

describe("release PR body", () => {
  const plan = (n) => ({ units: Array.from({ length: n }, (_, i) => ({ key: `modules/m${i}`, from: "0.1.0", to: "0.1.1" })) });

  it("leads with candidate or final and carries the unit section whole when it fits", () => {
    assert.equal(
      composeReleasePrBody({ units: "Merging this publishes **1 unit**.\n", plan: plan(1), candidate: false }),
      "Merging this publishes the **finals** below.\n\nMerging this publishes **1 unit**.\n",
    );
    assert.match(composeReleasePrBody({ units: "", plan: plan(0), candidate: true }), /\*\*candidates\*\*[\s\S]*No unit version moved/);
  });

  it("degrades the unit section in stages to stay under GitHub's body limit", () => {
    const compact = composeReleasePrBody({ units: "y".repeat(70_000), plan: plan(2), candidate: false });
    assert.ok(compact.length <= 65_000);
    assert.match(compact, /Merging this publishes 2 units: `modules\/m0` 0\.1\.0 → 0\.1\.1, `modules\/m1` 0\.1\.0 → 0\.1\.1\./);

    const counted = composeReleasePrBody({ units: "y".repeat(70_000), plan: plan(3_000), candidate: false });
    assert.ok(counted.length <= 65_000);
    assert.match(counted, /Merging this publishes 3000 units\. They did not fit GitHub's body limit/);
  });
});
