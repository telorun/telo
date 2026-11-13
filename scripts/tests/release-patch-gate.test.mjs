// The patch-only gate names each unit planned above `patch`.
// Run: node --test scripts/tests/release-patch-gate.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { nonPatchFindings, patchOnly } from "../release-patch-gate.mjs";

describe("patch-only gate", () => {
  it("names every unit whose level is not patch", () => {
    const findings = nonPatchFindings(
      {
        units: [
          { key: "kernel", level: "patch", from: "0.85.0", to: "0.85.1" },
          { key: "sdk", level: "minor", from: "0.85.0", to: "0.86.0" },
          { key: "modules/sql", level: "major", from: "1.0.0", to: "2.0.0" },
        ],
      },
      "release/0.85",
    );
    assert.equal(findings.length, 2);
    assert.match(findings[0], /^sdk is planned at 'minor'/);
    assert.match(findings[1], /^modules\/sql is planned at 'major'/);
  });

  it("holds only a release branch whose final is published", () => {
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    const repo = mkdtempSync(join(tmpdir(), "patch-gate-"));
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    git("tag", "v0.85.0");
    assert.equal(patchOnly({ cwd: repo, branch: "release/0.85" }), true);
    assert.equal(patchOnly({ cwd: repo, branch: "release/0.86" }), false);
    assert.equal(patchOnly({ cwd: repo, branch: "main" }), false);
  });
});
