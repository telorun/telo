// The version generator, the Rust-twin stamp and the changeset gate under
// changesets prerelease mode and on release branches, each run in a scratch
// workspace holding copies of the scripts. Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANGESETS_BIN = join(REPO, "node_modules", "@changesets", "cli", "bin.js");
const CARRIED = "cli/nodejs/src/release/carried-changes.ts";
const LINE = {
  "@telorun/analyzer": "analyzer/nodejs",
  "@telorun/cli": "cli/nodejs",
  "@telorun/kernel": "kernel/nodejs",
  "@telorun/language-server": "packages/language-server",
  "@telorun/cel": "cel/nodejs",
};
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function run(root, command, args, env = {}) {
  // The gate reads a pull request's refs from the environment; a test states its own,
  // or on the Version PR every case runs exempt as `changeset-release/*`.
  const inherited = { ...process.env };
  delete inherited.GITHUB_HEAD_REF;
  delete inherited.GITHUB_BASE_REF;
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...inherited, ...env } });
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** A workspace at `version` with a git history on `main`. */
function workspace(version = "0.84.2") {
  const root = mkdtempSync(join(tmpdir(), "telo-release-"));
  made.push(root);
  cpSync(join(REPO, "scripts"), join(root, "scripts"), {
    recursive: true,
    filter: (source) => !source.includes("tests") && !source.includes("db-init"),
  });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  // The gate reads which changesets a release branch carries through the CLI's file.
  put(root, CARRIED, readFileSync(join(REPO, CARRIED), "utf8"));
  put(root, "package.json", '{"name":"root","private":true,"version":"1.0.0"}');
  put(root, "pnpm-workspace.yaml", "packages:\n  - cli/*\n  - kernel/*\n  - analyzer/*\n  - cel/*\n  - packages/*\n  - other\n  - debug-ui\n");
  put(root, ".gitignore", "node_modules\nanalyzer/nodejs/src/telo-version.ts\npackages/language-server/src/engine-version.ts\ncel/nodejs/src/engine-version.ts\nkernel/nodejs/src/telo-runtime-version.ts\n");
  for (const [name, dir] of Object.entries(LINE)) {
    const devDependencies = name === "@telorun/cli" ? { "@telorun/debug-ui": "1.0.0" } : undefined;
    put(root, `${dir}/package.json`, JSON.stringify({ name, version, devDependencies }));
    put(root, `${dir}/src/index.ts`, "export {};\n");
  }
  put(root, "other/package.json", JSON.stringify({ name: "@telorun/other", version: "1.3.0" }));
  put(root, "other/index.js", "\n");
  put(root, "debug-ui/package.json", JSON.stringify({ name: "@telorun/debug-ui", version: "1.0.0" }));
  put(root, "cli/rust/Cargo.toml", `[package]\nname = "telorun-cli"\nversion = "${version}"\n`);
  put(root, "Cargo.lock", `version = 4\n\n[[package]]\nname = "telorun-cli"\nversion = "${version}"\n`);
  put(
    root,
    ".changeset/config.json",
    JSON.stringify({
      changelog: false, commit: false, fixed: [Object.keys(LINE)], linked: [], access: "public",
      baseBranch: "main", updateInternalDependencies: "patch", ignore: [],
    }),
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
  commit(root, "init");
  return root;
}

function changeset(root, id, bump, name = "@telorun/cli") {
  put(root, `.changeset/${id}.md`, `---\n"${name}": ${bump}\n---\n\nchange\n`);
}

function changesets(root, ...args) {
  const result = run(root, process.execPath, [CHANGESETS_BIN, ...args]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

function generated(root) {
  const result = run(root, process.execPath, ["scripts/generate-telo-version.mjs"]);
  assert.equal(result.status, 0, result.stderr);
  const read = (path, key) => new RegExp(`${key} = "([^"]+)"`).exec(readFileSync(join(root, path), "utf8"))[1];
  return {
    surface: read("analyzer/nodejs/src/telo-version.ts", "TELO_SURFACE_VERSION"),
    identity: read("kernel/nodejs/src/telo-runtime-version.ts", "TELO_RUNTIME_VERSION"),
  };
}

function gate(root, base) {
  const result = run(root, process.execPath, ["scripts/check-changeset-status.mjs", base]);
  if (process.env.GATE_DEBUG) console.error(result.stderr);
  return result;
}

describe("version generator", () => {
  it("main right after the cut, nothing pending", () => {
    assert.deepEqual(generated(workspace()), { surface: "0.84.2", identity: "0.84.2" });
  });

  it("main with a minor pending", () => {
    const root = workspace();
    changeset(root, "one", "minor");
    assert.deepEqual(generated(root), { surface: "0.85.0", identity: "0.85.0+unreleased" });
  });

  it("candidates: rc.0 released, then a pending patch, then after pre exit", () => {
    const root = workspace();
    changeset(root, "one", "minor");
    changesets(root, "pre", "enter", "rc");
    changesets(root, "version");
    assert.deepEqual(generated(root), { surface: "0.85.0", identity: "0.85.0-rc.0" });

    changeset(root, "two", "patch");
    assert.deepEqual(generated(root), { surface: "0.85.0", identity: "0.85.0-rc.1+unreleased" });

    changesets(root, "pre", "exit");
    assert.deepEqual(generated(root), { surface: "0.85.0", identity: "0.85.0+unreleased" });
  });
});

describe("Rust twins", () => {
  it("version-line writes a prerelease into Cargo.toml and Cargo.lock, and the gate accepts it", () => {
    const root = workspace();
    changeset(root, "one", "minor");
    changesets(root, "pre", "enter", "rc");
    changesets(root, "version");
    assert.equal(run(root, process.execPath, ["scripts/version-line.mjs"]).status, 0);
    assert.match(readFileSync(join(root, "cli/rust/Cargo.toml"), "utf8"), /version = "0.85.0-rc.0"/);
    assert.match(readFileSync(join(root, "Cargo.lock"), "utf8"), /version = "0.85.0-rc.0"/);
    commit(root, "version");
    assert.equal(gate(root, "HEAD").status, 0);
  });
});

describe("floors waiting for a release", () => {
  const MODULE = `kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.0
requires:
  telo: ">=unreleased" # waiting
  host: { node: ">=20.0.0" }
restrictions:
  - requires: { telo: '>=unreleased' }
    reason: Needs the next kernel.
  - versions: ">=1.0.0"
    requires: { telo: "<0.122.0" }
    reason: Broken above.
`;

  it("the version step rewrites >=unreleased in requires.telo and in entries, keeping the layout", () => {
    const root = workspace();
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n    - '!modules/skipped'\n");
    put(root, "modules/geocode/telo.yaml", MODULE);
    put(root, "modules/skipped/telo.yaml", MODULE);
    const result = run(root, process.execPath, ["scripts/version-line.mjs"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /modules\/geocode\/telo.yaml: requires.telo >=unreleased → >=0.84.2/);
    assert.match(result.stdout, /modules\/geocode\/telo.yaml: restrictions\[0\].requires.telo >=unreleased → >=0.84.2/);
    assert.equal(
      readFileSync(join(root, "modules/geocode/telo.yaml"), "utf8"),
      MODULE.replace('">=unreleased" # waiting', '">=0.84.2" # waiting').replace("'>=unreleased'", "'>=0.84.2'"),
    );
    assert.equal(readFileSync(join(root, "modules/skipped/telo.yaml"), "utf8"), MODULE);
  });
});

describe("changeset gate", () => {
  it("a main change with no changeset fails; a changeset covers it", () => {
    const root = workspace();
    git(root, "switch", "-q", "-c", "pr");
    put(root, "cli/nodejs/src/index.ts", "export const a = 1;\n");
    commit(root, "change");
    assert.equal(gate(root, "main").status, 1);
    changeset(root, "cover", "patch");
    assert.equal(gate(root, "main").status, 0);
  });

  it("takes the base from GITHUB_BASE_REF", () => {
    const root = workspace();
    git(root, "switch", "-q", "-c", "pr");
    put(root, "cli/nodejs/src/index.ts", "export const a = 1;\n");
    commit(root, "change");
    git(root, "update-ref", "refs/remotes/origin/main", "main");
    const result = run(root, process.execPath, ["scripts/check-changeset-status.mjs"], { GITHUB_BASE_REF: "main" });
    assert.equal(result.status, 1);
  });

  it("a changeset a candidate already released does not cover a later change", () => {
    const root = workspace();
    changeset(root, "one", "minor");
    changesets(root, "pre", "enter", "rc");
    changesets(root, "version");
    run(root, process.execPath, ["scripts/version-line.mjs"]);
    commit(root, "rc.0");
    git(root, "switch", "-q", "-c", "fix");
    put(root, "cli/nodejs/src/index.ts", "export const a = 1;\n");
    commit(root, "fix");
    const refused = gate(root, "main");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /@telorun\/cli changed a published file but no changeset covers it/);
    changeset(root, "two", "patch");
    assert.equal(gate(root, "main").status, 0);
  });

  it("on main, a changeset the live release branch carries covers nothing", () => {
    const root = workspace();
    changeset(root, "shipped", "patch");
    commit(root, "changeset before the cut");
    git(root, "branch", "release/0.85");
    git(root, "switch", "-q", "-c", "pr");
    put(root, "cli/nodejs/src/index.ts", "export const a = 1;\n");
    commit(root, "change");
    const refused = gate(root, "main");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /@telorun\/cli changed a published file but no changeset covers it/);
    git(root, "branch", "-D", "release/0.85");
    assert.equal(gate(root, "main").status, 0);
  });

  it("a release branch past its final accepts only patch changesets", () => {
    const root = workspace();
    git(root, "switch", "-q", "-c", "release/0.85");
    git(root, "update-ref", "refs/remotes/origin/release/0.85", "release/0.85");
    git(root, "tag", "v0.85.0");
    git(root, "switch", "-q", "-c", "fix");
    changeset(root, "brave-otters-sing", "minor", "@telorun/other");
    commit(root, "minor");
    const refused = gate(root, "origin/release/0.85");
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /release\/0\.85 accepts only patch changesets; @telorun\/other has a minor \(\.changeset\/brave-otters-sing\.md\)\./,
    );
    put(root, ".changeset/pre.json", JSON.stringify({ mode: "pre", tag: "rc", initialVersions: {}, changesets: [] }));
    assert.equal(gate(root, "origin/release/0.85").status, 0);
  });

  it("a freshly cut branch, with no final yet, carries its minor changesets", () => {
    const root = workspace();
    git(root, "switch", "-q", "-c", "release/0.85");
    git(root, "update-ref", "refs/remotes/origin/release/0.85", "release/0.85");
    git(root, "switch", "-q", "-c", "fix");
    changeset(root, "brave-otters-sing", "minor", "@telorun/other");
    commit(root, "minor");
    assert.equal(gate(root, "origin/release/0.85").status, 0);
  });

  it("exempts the release machinery's pull requests from coverage only", () => {
    const root = workspace();
    git(root, "switch", "-q", "-c", "pr");
    put(root, "cli/nodejs/src/index.ts", "export const a = 1;\n");
    commit(root, "change");
    for (const head of ["changeset-release/release/0.85", "release-record/release/0.85"]) {
      const result = run(root, process.execPath, ["scripts/check-changeset-status.mjs", "main"], { GITHUB_HEAD_REF: head });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /coverage is exempt/);
    }
    assert.equal(run(root, process.execPath, ["scripts/check-changeset-status.mjs", "main"], { GITHUB_HEAD_REF: "feat/x" }).status, 1);
    put(root, "cli/rust/Cargo.toml", '[package]\nname = "telorun-cli"\nversion = "0.0.1"\n');
    commit(root, "twin drifts");
    const twin = run(root, process.execPath, ["scripts/check-changeset-status.mjs", "main"], { GITHUB_HEAD_REF: "release-record/release/0.85" });
    assert.equal(twin.status, 1);
    assert.match(twin.stderr, /cli\/rust\/Cargo\.toml is 0\.0\.1 but its Node twin/);
  });
});
