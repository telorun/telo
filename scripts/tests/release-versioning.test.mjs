// The version modules a build embeds, and what a Publish run reads off its release
// commit: the moved units, the npm packages it publishes, the image tags and the
// charts. Each generator case runs in a scratch workspace holding copies of the
// scripts. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { imageTags } from "../image-tags.mjs";
import { chartsToPublish, pushBase } from "../publish-charts.mjs";
import { distTagOf, packagesToPublish } from "../publish-packages.mjs";
import { movedUnits, movedVersions } from "../release-units.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A workspace holding the generator's scripts and the four packages it writes. */
function generatorWorkspace(version) {
  const root = mkdtempSync(join(tmpdir(), "telo-version-line-"));
  made.push(root);
  for (const script of ["generate-telo-version.mjs", "version-line.mjs"]) {
    cpSync(join(REPO, "scripts", script), join(root, "scripts", script));
  }
  put(root, "analyzer/nodejs/package.json", JSON.stringify({ name: "@telorun/analyzer", version }));
  for (const dir of ["cel/nodejs", "kernel/nodejs", "packages/language-server"]) {
    put(root, `${dir}/package.json`, JSON.stringify({ name: dir, version }));
    mkdirSync(join(root, dir, "src"), { recursive: true });
  }
  mkdirSync(join(root, "analyzer/nodejs/src"), { recursive: true });
  return root;
}

function generate(root, cwd, ...args) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "generate-telo-version.mjs"), ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const read = (root, path) => readFileSync(join(root, path), "utf8");

describe("the version modules", () => {
  it("embed the recorded version with +unreleased in every build, from the repository root", () => {
    const root = generatorWorkspace("0.85.0-rc.2");
    generate(root, root);
    assert.match(read(root, "analyzer/nodejs/src/telo-version.ts"), /TELO_SURFACE_VERSION = "0\.85\.0";/);
    assert.match(read(root, "analyzer/nodejs/src/telo-version.ts"), /TELO_RUNNING_SURFACE = "0\.85\.0\+unreleased";/);
    assert.match(read(root, "cel/nodejs/src/engine-version.ts"), /ENGINE_VERSION = "0\.85\.0-rc\.2\+unreleased";/);
    assert.match(read(root, "kernel/nodejs/src/telo-runtime-version.ts"), /TELO_RUNTIME_VERSION = "0\.85\.0-rc\.2\+unreleased";/);
    assert.match(read(root, "packages/language-server/src/engine-version.ts"), /TELO_ENGINE_VERSION = "0\.85\.0-rc\.2\+unreleased";/);
  });

  it("embed exactly the version in a package's published build, and write that package alone", () => {
    const root = generatorWorkspace("0.85.0");
    generate(root, root);
    generate(root, join(root, "cel/nodejs"), "--published");
    assert.match(read(root, "cel/nodejs/src/engine-version.ts"), /ENGINE_VERSION = "0\.85\.0";/);
    assert.match(read(root, "kernel/nodejs/src/telo-runtime-version.ts"), /\+unreleased/);
    generate(root, join(root, "analyzer/nodejs"), "--published");
    assert.match(read(root, "analyzer/nodejs/src/telo-version.ts"), /TELO_RUNNING_SURFACE = "0\.85\.0";/);
  });

  it("write only the packages a partial checkout holds", () => {
    const root = mkdtempSync(join(tmpdir(), "telo-version-line-partial-"));
    made.push(root);
    for (const script of ["generate-telo-version.mjs", "version-line.mjs"]) {
      cpSync(join(REPO, "scripts", script), join(root, "scripts", script));
    }
    mkdirSync(join(root, "analyzer/nodejs/src"), { recursive: true });
    const result = spawnSync(process.execPath, [join(root, "scripts", "generate-telo-version.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
  });
});

/** A repository whose second commit versions `kernel` final and `apps/hub` as a candidate. */
function releasedRepo() {
  const root = mkdtempSync(join(tmpdir(), "telo-release-units-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  put(root, ".changes/ledger.yaml", "units:\n  kernel:\n    version: 0.84.0\n  apps/hub:\n    version: 0.27.0\n  modules/console:\n    version: 0.18.0\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  put(
    root,
    ".changes/ledger.yaml",
    "units:\n  kernel:\n    version: 0.85.0\n  apps/hub:\n    version: 0.27.0\n    candidate:\n      version: 0.28.0-rc.1\n  modules/console:\n    version: 0.18.0\n",
  );
  git(root, "commit", "-q", "-am", "chore(release): version");
  return root;
}

describe("the units a release commit moved", () => {
  it("are the ledger's final or candidate versions that moved against the parent, one row per package", () => {
    const root = releasedRepo();
    const moved = movedVersions({ cwd: root, commit: "HEAD" });
    assert.deepEqual(moved, [
      { key: "apps/hub", version: "0.28.0-rc.1" },
      { key: "kernel", version: "0.85.0" },
    ]);
    const order = [
      { key: "kernel", ecosystem: "cargo", path: "kernel/rust", version: "0.85.0" },
      { key: "kernel", ecosystem: "npm", path: "kernel/nodejs", version: "0.85.0" },
      { key: "modules/console", ecosystem: "telo", path: "modules/console", version: "0.18.0", destination: "oci://ghcr.io/telorun/console" },
      { key: "apps/hub", ecosystem: "docker", path: "apps/hub", version: "0.28.0-rc.1", destination: "docker.io/telorun/hub" },
    ];
    const files = { "kernel/rust/Cargo.toml": '[package]\nname = "telo-kernel"\n', "kernel/nodejs/package.json": '{"name":"@telorun/kernel"}' };
    assert.deepEqual(movedUnits({ moved, order, read: (file) => files[file] }), [
      { key: "kernel", name: "telo-kernel", version: "0.85.0", ecosystem: "cargo" },
      { key: "kernel", name: "@telorun/kernel", version: "0.85.0", ecosystem: "npm" },
      { key: "apps/hub", name: "docker.io/telorun/hub", version: "0.28.0-rc.1", ecosystem: "docker" },
    ]);
  });
});

describe("what a Publish run publishes", () => {
  it("publishes each npm row npm lacks, in order, a candidate under rc and a final under latest", () => {
    const rows = [
      { key: "sdk", ecosystem: "cargo", path: "sdk/rust", version: "0.85.0-rc.1" },
      { key: "sdk", ecosystem: "npm", path: "sdk/nodejs", version: "0.85.0-rc.1" },
      { key: "packages/glob", ecosystem: "npm", path: "packages/glob/nodejs", version: "0.3.2" },
      { key: "packages/debug-ui", ecosystem: "npm", path: "packages/debug-ui", version: "0.7.0" },
    ];
    const names = { "sdk/nodejs": "@telorun/sdk", "packages/glob/nodejs": "@telorun/glob", "packages/debug-ui": "@telorun/debug-ui" };
    const published = new Set(["@telorun/glob@0.3.2"]);
    assert.deepEqual(
      packagesToPublish({ rows, nameOf: (path) => names[path], isPublished: (name, version) => published.has(`${name}@${version}`) }),
      [
        { key: "sdk", path: "sdk/nodejs", name: "@telorun/sdk", version: "0.85.0-rc.1", distTag: "rc" },
        { key: "packages/debug-ui", path: "packages/debug-ui", name: "@telorun/debug-ui", version: "0.7.0", distTag: "latest" },
      ],
    );
    assert.equal(distTagOf("1.0.0-beta.3"), "beta");
    assert.equal(distTagOf("0.85.0-rc.1"), "rc");
    assert.equal(distTagOf("0.85.0"), "latest");
  });

  it("tags an image with its unit's version, latest only for a final no released version exceeds", () => {
    const units = [{ key: "apps/hub", name: "docker.io/telorun/hub", version: "0.28.0", ecosystem: "docker" }];
    assert.deepEqual(imageTags({ units, key: "apps/hub", sha: "abc1234", releasedVersions: ["0.27.0", "0.28.0"] }).tags, [
      "docker.io/telorun/hub:latest",
      "docker.io/telorun/hub:0.28.0",
      "docker.io/telorun/hub:sha-abc1234",
    ]);
    assert.deepEqual(imageTags({ units, key: "apps/hub", sha: "abc1234", releasedVersions: ["0.29.0"] }).tags, [
      "docker.io/telorun/hub:0.28.0",
      "docker.io/telorun/hub:sha-abc1234",
    ]);
    const candidate = [{ ...units[0], version: "0.28.0-rc.1" }];
    assert.deepEqual(imageTags({ units: candidate, key: "apps/hub", sha: "abc1234", suffix: "-slim", releasedVersions: [] }).tags, [
      "docker.io/telorun/hub:0.28.0-rc.1-slim",
      "docker.io/telorun/hub:sha-abc1234-slim",
    ]);
    assert.deepEqual(imageTags({ units, key: "apps/studio", sha: "abc1234", releasedVersions: [] }), { version: "", tags: [] });
  });

  it("pushes the chart of every helm row the release moved to its destination's registry", () => {
    const order = [
      { key: "apps/k8s-runner", ecosystem: "helm", path: "apps/k8s-runner/chart", version: "0.26.0", destination: "oci://ghcr.io/telorun/charts/k8s-runner" },
      { key: "apps/hub", ecosystem: "helm", path: "apps/hub/chart", version: "0.27.0", destination: "oci://ghcr.io/telorun/charts/hub" },
    ];
    assert.deepEqual(chartsToPublish({ units: [{ key: "apps/k8s-runner", version: "0.26.0" }], order }), [
      { key: "apps/k8s-runner", path: "apps/k8s-runner/chart", destination: "oci://ghcr.io/telorun/charts/k8s-runner", version: "0.26.0" },
    ]);
    assert.equal(pushBase("oci://ghcr.io/telorun/charts/k8s-runner"), "oci://ghcr.io/telorun/charts");
  });
});
