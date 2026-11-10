// Release-script behaviours pinned against fixture git repositories:
// the module-release tag of a re-run, the major-bump guard over modules, the constant
// git cost of classifying a publication commit, and the consumer-manifest listing.
// Run: node --test scripts/tests/release-scripts-fixes.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const commit = (root, message) => {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
};
function repo() {
  const root = mkdtempSync(join(tmpdir(), "telo-fix-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}
const load = (name) => import(pathToFileURL(join(REPO, "scripts", name)).href);
const moduleDoc = (version) => `kind: Telo.Library\nmetadata:\n  name: A\n  version: ${version}\n`;

describe("module release tag of a re-run", () => {
  it("counts the versions the commit moved, published or not, and names the same tag again", async () => {
    const { versionsMovedInHead } = await load("module-versions-moved.mjs");
    const { numberedTag } = await load("release-channel.mjs");
    const root = repo();
    put(root, "modules/a/telo.yaml", moduleDoc("0.1.0"));
    commit(root, "init");
    put(root, "modules/a/telo.yaml", moduleDoc("0.2.0"));
    commit(root, "version modules");

    const manifests = ["modules/a/telo.yaml"];
    assert.deepEqual([...versionsMovedInHead(root, manifests)], manifests);
    const first = numberedTag({ cwd: root, branch: "release/0.85", kind: "modules" });
    assert.equal(first.tag, "modules-0.85-1");

    git(root, "tag", first.tag);
    assert.deepEqual([...versionsMovedInHead(root, manifests)], manifests);
    assert.equal(numberedTag({ cwd: root, branch: "release/0.85", kind: "modules" }).tag, first.tag);

    put(root, "README.md", "x");
    commit(root, "later");
    assert.equal(versionsMovedInHead(root, manifests).size, 0);
  });
});

describe("check-no-major-bump over modules", () => {
  function workspace(version) {
    const root = repo();
    mkdirSync(join(root, "scripts"));
    cpSync(join(REPO, "scripts/check-no-major-bump.mjs"), join(root, "scripts/check-no-major-bump.mjs"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n    - path: blueprints/*\n");
    put(root, "modules/a/telo.yaml", moduleDoc(version));
    return spawnSync("node", ["scripts/check-no-major-bump.mjs"], { cwd: root, encoding: "utf8" });
  }
  it("fails naming a module at 1.0.0", () => {
    const run = workspace("1.0.0");
    assert.equal(run.status, 1);
    assert.match(run.stderr, /modules\/a@1\.0\.0/);
  });
  it("passes a pre-1.0 module", () => {
    assert.equal(workspace("0.9.0").status, 0);
  });
});

describe("release-commit git cost", () => {
  it("classifies a publication commit touching 30 files in a constant number of git processes", async () => {
    const { isPublicationCommit } = await load("release-commit.mjs");
    const root = repo();
    for (let i = 0; i < 30; i++) put(root, `examples/e${i}/telo.yaml`, `imports:\n  A: ../../modules/a\n`);
    commit(root, "init");
    for (let i = 0; i < 30; i++) put(root, `examples/e${i}/telo.yaml`, `imports:\n  A: oci://ghcr.io/telorun/a@1.0.0\n`);
    commit(root, "chore(release): publish v0.85.1");

    const bin = mkdtempSync(join(tmpdir(), "telo-fakegit-"));
    made.push(bin);
    const log = join(bin, "count");
    writeFileSync(log, "");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      assert.equal(isPublicationCommit({ cwd: root, commit: "HEAD" }), true);
    } finally {
      process.env.PATH = path;
    }
    const spawned = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    assert.ok(spawned <= 6, `${spawned} git processes`);
  });
});

describe("consumerManifests", () => {
  it("leaves a gitignored manifest out and lists an untracked one", async () => {
    const { consumerManifests } = await load("release-imports.mjs");
    const root = repo();
    put(root, ".gitignore", ".scratch/\n");
    put(root, "apps/a/telo.yaml", "imports:\n  A: ../x\n");
    put(root, "apps/a/.scratch/p1.yaml", "imports:\n  A: ../x\n");
    commit(root, "init");
    put(root, "examples/new/telo.yaml", "imports:\n  A: ../x\n");
    assert.deepEqual(consumerManifests(root), ["apps/a/telo.yaml", "examples/new/telo.yaml"]);
  });
});
