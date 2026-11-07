// The link rewrite shared by the site build and by npm / .vsix packing, and the
// pack script's promise to leave the working tree as it found it.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { rewriteMarkdownLinks } = createRequire(import.meta.url)("../repo-links.cjs");
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "repo-links-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("rewriteMarkdownLinks", () => {
  it("turns relative links into tag URLs: files blob, directories tree, images raw", () => {
    const repoRoot = tree({ "analyzer/migrations/a.json": "{}", "docs/x.md": "", "docs/p.png": "" });
    const out = rewriteMarkdownLinks(
      [
        "[m](../analyzer/migrations/) [x](./x.md#top) ![p](p.png)",
        "[abs](https://telo.run/a) [anchor](#a) [gone](missing.md)",
        "```",
        "[fenced](x.md)",
        "```",
      ].join("\n"),
      { repoRoot, fromDir: "docs", tag: "v0.85.0-rc.1" },
    );
    assert.equal(
      out,
      [
        "[m](https://github.com/telorun/telo/tree/v0.85.0-rc.1/analyzer/migrations/) [x](https://github.com/telorun/telo/blob/v0.85.0-rc.1/docs/x.md#top) ![p](https://github.com/telorun/telo/raw/v0.85.0-rc.1/docs/p.png)",
        "[abs](https://telo.run/a) [anchor](#a) [gone](missing.md)",
        "```",
        "[fenced](x.md)",
        "```",
      ].join("\n"),
    );
  });
});

describe("rewrite-pack-links", () => {
  it("rewrites the packed markdown to the package's tag and restores a tracked file", () => {
    const root = tree({
      "scripts/repo-links.cjs": readFileSync(join(SCRIPTS, "repo-links.cjs"), "utf8"),
      "scripts/rewrite-pack-links.mjs": readFileSync(join(SCRIPTS, "rewrite-pack-links.mjs"), "utf8"),
      "kernel/specs/a.md": "",
      "pkg/package.json": JSON.stringify({ name: "@telorun/pkg", version: "1.2.3" }),
      "pkg/README.md": "[a](../kernel/specs/a.md)\n",
    });
    const script = join(root, "scripts", "rewrite-pack-links.mjs");
    const run = (...args) => spawnSync(process.execPath, [script, join(root, "pkg"), ...args], { encoding: "utf8" });
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");

    const withTag = (tag) => spawnSync(process.execPath, [script, join(root, "pkg")], { encoding: "utf8", env: { ...process.env, TELO_PACK_LINKS_TAG: tag } });
    assert.equal(withTag("packages-0.85-2").status, 0);
    assert.equal(
      readFileSync(join(root, "pkg", "README.md"), "utf8"),
      "[a](https://github.com/telorun/telo/blob/packages-0.85-2/kernel/specs/a.md)\n",
    );
    assert.equal(run("--restore").status, 0);
    assert.equal(readFileSync(join(root, "pkg", "README.md"), "utf8"), "[a](../kernel/specs/a.md)\n");

    const local = spawnSync(process.execPath, [script, join(root, "pkg")], { encoding: "utf8", env: { ...process.env, TELO_PACK_LINKS_TAG: "" } });
    assert.match(local.stdout, /links to main/);
    assert.match(readFileSync(join(root, "pkg", "README.md"), "utf8"), /blob\/main\/kernel\/specs\/a\.md/);
    assert.equal(run("--restore").status, 0);
    assert.equal(readFileSync(join(root, "pkg", "README.md"), "utf8"), "[a](../kernel/specs/a.md)\n");
  });
});
