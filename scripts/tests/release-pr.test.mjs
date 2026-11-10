// The release PR's version command and its body. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { composeReleasePrBody } from "../release-pr-body.mjs";
import { versionReleasePr } from "../release-pr-version.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The commands the version command runs over a tree whose npm version step leaves
 *  `.changeset/pre.json` (`candidates`) or not. */
function versionCommands({ candidates }) {
  const root = mkdtempSync(join(tmpdir(), "telo-release-pr-"));
  made.push(root);
  const ran = [];
  const released = versionReleasePr({
    cwd: root,
    args: ["--final"],
    planFile: join(root, "plan.json"),
    run: (command, args, { stdoutFile } = {}) => {
      ran.push([command === process.execPath ? "node" : command, ...args.map((arg) => arg.replace(root, "<root>"))].join(" ") + (stdoutFile ? " > plan" : ""));
      if (args[0]?.endsWith("release-version.mjs") && candidates) {
        mkdirSync(join(root, ".changeset"), { recursive: true });
        writeFileSync(join(root, ".changeset", "pre.json"), '{"mode":"pre"}');
      }
    },
  });
  return { released, ran };
}

describe("release PR version command", () => {
  it("releases the modules after the npm version step, plan captured before the apply, outside candidates", () => {
    assert.deepEqual(versionCommands({ candidates: false }), {
      released: true,
      ran: [
        "node <root>/scripts/release-version.mjs --final",
        "pnpm install --frozen-lockfile",
        "pnpm -r --if-present build",
        "node ./cli/nodejs/bin/telo.mjs release status -o json --base HEAD > plan",
        "node ./cli/nodejs/bin/telo.mjs release apply --base HEAD",
        "node <root>/scripts/stamp-chart-version.mjs",
      ],
    });
  });

  it("versions only the npm packages in candidates", () => {
    assert.deepEqual(versionCommands({ candidates: true }), {
      released: false,
      ran: ["node <root>/scripts/release-version.mjs --final"],
    });
  });
});

describe("release PR body", () => {
  const plan = (n) => ({ modules: Array.from({ length: n }, (_, i) => ({ key: `modules/m${i}`, from: "0.1.0", to: "0.1.1" })) });

  it("appends the module section whole when it fits, and nothing when no module moves", () => {
    assert.equal(
      composeReleasePrBody({ changesets: "## Releases\n", modules: "Merging this publishes **1 module**.\n", plan: plan(1) }),
      "## Releases\n\n# Modules\n\nMerging this publishes **1 module**.\n",
    );
    assert.equal(composeReleasePrBody({ changesets: "## Releases\n", modules: "No module version moved.\n", plan: plan(0) }), "## Releases\n");
  });

  it("degrades the module section in stages to stay under GitHub's body limit", () => {
    const changesets = "x".repeat(59_000);
    const compact = composeReleasePrBody({ changesets, modules: "y".repeat(10_000), plan: plan(2) });
    assert.ok(compact.length <= 65_000);
    assert.match(compact, /Merging this also publishes 2 modules: `modules\/m0` 0\.1\.0 → 0\.1\.1, `modules\/m1` 0\.1\.0 → 0\.1\.1\./);

    const counted = composeReleasePrBody({ changesets, modules: "y".repeat(10_000), plan: plan(400) });
    assert.ok(counted.length <= 65_000);
    assert.match(counted, /Merging this also publishes 400 modules\. They did not fit GitHub's body limit/);
  });
});
