// The copy-and-rewrite orchestration of `pnpm run starters`, with the CLI stood in by a function.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildPublishedStarters, rewriteAvailable, startMode } from "../serve-starters.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "serve-starters-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const files = {
  "starters/starters.json": "{}",
  "starters/apps/a/telo.yaml": "imports:\n  Sql: ../../../modules/sql\n",
  "starters/apps/b/telo.yaml": "kind: Telo.Application\n",
  "starters/apps/a/tests/t.yaml": "imports:\n  Sql: ../../../../modules/sql\n",
};

describe("buildPublishedStarters", () => {
  it("copies the gallery without its tests and hands only manifests with imports to the rewrite", () => {
    const root = tree(files);
    let handed;
    const built = buildPublishedStarters({
      root,
      rewrite: (manifests) => ((handed = manifests), { status: 0, result: {} }),
    });
    assert.deepEqual(handed, ["starters-published/apps/a/telo.yaml"]);
    assert.deepEqual(built.kept, []);
    assert.ok(existsSync(join(root, "starters-published/starters.json")));
    assert.ok(!existsSync(join(root, "starters-published/apps/a/tests")));
    assert.equal(readFileSync(join(root, "starters/apps/a/telo.yaml"), "utf8"), files["starters/apps/a/telo.yaml"]);
  });

  it("rebuilds the copy on each run", () => {
    const root = tree(files);
    const rewrite = () => ({ status: 0, result: {} });
    buildPublishedStarters({ root, rewrite });
    writeFileSync(join(root, "starters-published/stale.txt"), "x");
    buildPublishedStarters({ root, rewrite });
    assert.ok(!existsSync(join(root, "starters-published/stale.txt")));
  });

  it("returns the imports the command kept relative on exit 1", () => {
    const root = tree(files);
    const kept = [{ manifest: "starters-published/apps/a/telo.yaml", alias: "Sql", source: "../x", reason: "unreleased" }];
    const built = buildPublishedStarters({ root, rewrite: () => ({ status: 1, result: { keptRelative: kept } }) });
    assert.deepEqual(built.kept, kept);
  });

  it("fails when the command fails without reporting a kept import", () => {
    const root = tree(files);
    assert.throws(() => buildPublishedStarters({ root, rewrite: () => ({ status: 2, result: undefined }) }), /exited 2/);
    assert.throws(() => buildPublishedStarters({ root, rewrite: () => ({ status: 1, result: {} }) }), /exited 1/);
  });

  it("fails, naming the messages, when the command reports errors, and does not count them as kept", () => {
    const root = tree(files);
    const errors = [{ manifest: "starters-published/apps/a/telo.yaml", message: "registry unreachable" }];
    for (const status of [1, 2]) {
      assert.throws(
        () => buildPublishedStarters({ root, rewrite: () => ({ status, result: { keptRelative: [], errors } }) }),
        /registry unreachable/,
      );
    }
  });
});

describe("rewriteAvailable", () => {
  it("needs TELO_CLI or a built CLI", () => {
    const root = tree({ "cli/nodejs/dist/.keep": "" });
    assert.equal(rewriteAvailable({ root, env: {} }), false);
    assert.equal(rewriteAvailable({ root, env: { TELO_CLI: "x" } }), true);
    writeFileSync(join(root, "cli/nodejs/dist/cli.js"), "");
    assert.equal(rewriteAvailable({ root, env: {} }), true);
  });
});

describe("startMode", () => {
  const root = tree({ "cli/nodejs/dist/cli.js": "" });
  it("serves as given with --dir or a non-empty STARTERS_DIR, copying nothing", () => {
    assert.equal(startMode({ args: ["--dir", "."], root, env: {} }), "as-given");
    assert.equal(startMode({ args: ["--dir=."], root, env: {} }), "as-given");
    assert.equal(startMode({ args: [], root, env: { STARTERS_DIR: "x" } }), "as-given");
    assert.equal(startMode({ args: [], root, env: { STARTERS_DIR: "" } }), "published");
  });
  it("falls back to the checkout without a CLI", () => {
    assert.equal(startMode({ args: [], root: tree({}), env: {} }), "checkout");
  });
});
