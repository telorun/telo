// The release-branch scripts — live branch, the Cut / Finish / Publish refusals,
// channel classification, the names a release gets and the record of a release on
// main — each run against a scratch git repository holding copies of the scripts
// (and links to the release planner, analyzer and CLI sources the record reads under bun).
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = join(REPO, "node_modules", ".bin", "bun");
// The record reads the release planner, the analyzer and the CLI's release
// modules from source.
const SOURCES = [
  "release/nodejs/src",
  "release/nodejs/node_modules",
  "analyzer/nodejs/src",
  "analyzer/nodejs/node_modules",
  "cli/nodejs/src",
  "cli/nodejs/node_modules",
];
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

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** A workspace at `version` on `main`. */
function workspace(version) {
  const root = mkdtempSync(join(tmpdir(), "telo-branches-"));
  made.push(root);
  cpSync(join(REPO, "scripts"), join(root, "scripts"), {
    recursive: true,
    filter: (source) => !source.includes("tests") && !source.includes("db-init"),
  });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  put(root, "package.json", '{"name":"root","private":true,"version":"1.0.0"}');
  put(root, "pnpm-workspace.yaml", "packages:\n  - cli/*\n  - kernel/*\n  - analyzer/*\n  - cel/*\n  - packages/*\n");
  put(root, ".gitignore", ["node_modules", ...SOURCES].join("\n") + "\n");
  for (const [name, dir] of Object.entries(LINE)) put(root, `${dir}/package.json`, JSON.stringify({ name, version }));
  for (const dir of SOURCES) {
    mkdirSync(dirname(join(root, dir)), { recursive: true });
    symlinkSync(join(REPO, dir), join(root, dir));
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
  commit(root, "init");
  return root;
}

/** Stand in for `telo release status -o json`: a plan moving the telo line
 *  (`analyzer`) to `to` at `level`, or nothing. */
function linePlan(root, to, level) {
  const plan = { units: to ? [{ key: "analyzer", from: "0.0.0", to, level, reasons: [], entries: [] }] : [] };
  put(root, "cli/nodejs/bin/telo.mjs", `process.stdout.write(${JSON.stringify(JSON.stringify(plan))});\n`);
}

/** `.changes/ledger.yaml` recording each unit at its version. */
function ledger(root, units) {
  put(root, ".changes/ledger.yaml", "units:\n" + Object.entries(units).map(([key, version]) => `  ${key}:\n    version: ${version}\n`).join(""));
}

/** Make `branch` from the current commit of main, run `edit` on it and come back. */
function branch(root, name, edit = () => {}) {
  git(root, "switch", "-q", "-c", name);
  edit();
  if (git(root, "status", "--porcelain")) commit(root, `edit ${name}`);
  git(root, "switch", "-q", "main");
}

function script(root, name, args, env = {}, runtime = process.execPath) {
  return spawnSync(runtime, [join(root, "scripts", name), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", ...env },
  });
}

const refused = (result) => /^::error::(.*)$/m.exec(result.stdout)?.[1];

/** Run `body` (module code over `recordPlan`) under bun in `root`; its stdout as JSON. */
function underRecord(root, body) {
  const result = spawnSync(BUN, ["-e", `const { recordPlan } = await import("./scripts/release-record.mjs");\n${body}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

/** The record of `tag` as `{ writes: { path: text }, deletions }`. */
function recordPlanOf(root, tag) {
  return underRecord(
    root,
    `const plan = recordPlan({ tag: ${JSON.stringify(tag)} });\n` +
      "console.log(JSON.stringify({ writes: Object.fromEntries(plan.writes.map((w) => [w.path, w.text])), deletions: plan.deletions }));",
  );
}

/** Apply the copy-and-delete half of the record of `tag` to main's tree. */
function applyRecord(root, tag) {
  underRecord(
    root,
    'const { writeFileSync, rmSync } = await import("node:fs");\n' +
      `const plan = recordPlan({ tag: ${JSON.stringify(tag)} });\n` +
      "for (const w of plan.writes) writeFileSync(w.path, w.text);\n" +
      "for (const d of plan.deletions) rmSync(d);",
  );
}

/** The timeline of the plan: 0.85.0 shipped, release/0.85 live, main on its way to 0.86. */
function timeline() {
  const root = workspace("0.85.0");
  branch(root, "release/0.85");
  linePlan(root, "0.86.0", "minor");
  commit(root, "feat on main");
  return root;
}

describe("Start release candidates refusals", () => {
  it("refuses off main", () => {
    const root = timeline();
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "feat/x"]);
    assert.equal(refused(result), "Error: Start release candidates runs on main; feat/x is not main.");
  });

  it("passes with no release branch and names the minor main's release plan reaches", () => {
    const root = workspace("0.84.2");
    linePlan(root, "0.85.0", "minor");
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "main"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^release=0\.85$/m);
  });

  it("refuses while the live branch is in candidates", () => {
    const root = workspace("0.84.2");
    branch(root, "release/0.85", () => {
      put(root, "cli/nodejs/package.json", '{"name":"@telorun/cli","version":"0.85.0-rc.1"}');
    });
    git(root, "tag", "v0.85.0-rc.1", "release/0.85");
    linePlan(root, "0.86.0", "minor");
    commit(root, "feat");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.",
    );
  });

  it("refuses while the live branch holds a fragment", () => {
    const root = workspace("0.85.0");
    branch(root, "release/0.85", () => put(root, ".changes/pending/quiet-lamps-glow.yaml", "units: { cli: Fixed }\nbody: x\n"));
    linePlan(root, "0.86.0", "minor");
    commit(root, "feat");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: release/0.85 holds unreleased changes (.changes/pending/quiet-lamps-glow.yaml). Publish them before cutting 0.86.",
    );
  });

  it("refuses until main records the live branch's newest release tag", () => {
    const root = timeline();
    const module = (version) => `kind: Telo.Library\nmetadata:\n  name: A\n  version: ${version}\n`;
    put(root, "telo-workspace.yaml", "release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n");
    put(root, "modules/a/telo.yaml", module("1.0.0"));
    commit(root, "module on main");
    git(root, "switch", "-q", "release/0.85");
    put(root, "telo-workspace.yaml", "release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n");
    put(root, "modules/a/telo.yaml", module("1.1.0"));
    put(root, "modules/a/CHANGELOG.md", "# Changelog\n\n## 1.1.0\n");
    commit(root, "modules");
    git(root, "tag", "modules-0.85-1");
    git(root, "switch", "-q", "main");

    const cut = () => script(root, "release-branch.mjs", ["cut-check", "--ref", "main"], {}, BUN);
    assert.equal(
      refused(cut()),
      'Error: main does not record modules-0.85-1. Merge "chore(release): record modules-0.85-1 on main" first.',
    );
    applyRecord(root, "modules-0.85-1");
    commit(root, "chore(release): record modules-0.85-1 on main");
    const result = cut();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^release=0\.86$/m);
  });

  it("refuses when main's release plan moves the line by a patch, or not at all", () => {
    const root = workspace("0.85.0");
    linePlan(root, "0.85.1", "patch");
    commit(root, "fix");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: main's release plan moves the telo line to 0.85.1, a patch. Add an Added fragment for the line before cutting.",
    );
    linePlan(root);
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: main's release plan moves no telo version. Add an Added fragment for the line before cutting.",
    );
  });
});

describe("Publish final release refusals", () => {
  it("on main, accepts what the cut accepts and names the branch it cuts straight to the final", () => {
    const root = workspace("0.84.2");
    linePlan(root, "0.85.0", "minor");
    commit(root, "feat");
    const result = script(root, "release-branch.mjs", ["finish-check", "--ref", "main"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^release=0\.85$/m);
    assert.match(result.stdout, /^branch=release\/0\.85$/m);
    assert.match(result.stdout, /^direct=true$/m);
  });

  it("on main, refuses what the cut refuses: a live branch in candidates, an existing branch, a patch-only plan", () => {
    const finish = (root) => refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "main"]));
    const candidates = workspace("0.84.2");
    branch(candidates, "release/0.85", () => {
      put(candidates, "cli/nodejs/package.json", '{"name":"@telorun/cli","version":"0.85.0-rc.1"}');
    });
    git(candidates, "tag", "v0.85.0-rc.1", "release/0.85");
    linePlan(candidates, "0.86.0", "minor");
    commit(candidates, "feat");
    assert.equal(finish(candidates), "Error: release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.");

    const existing = workspace("0.84.2");
    branch(existing, "release/0.85");
    linePlan(existing, "0.85.0", "minor");
    commit(existing, "feat");
    assert.equal(finish(existing), "Error: release/0.85 already exists. Land the change on it, or add a fragment for the next minor.");

    const patch = workspace("0.85.0");
    linePlan(patch, "0.85.1", "patch");
    commit(patch, "fix");
    assert.equal(
      finish(patch),
      "Error: main's release plan moves the telo line to 0.85.1, a patch. Add an Added fragment for the line before cutting.",
    );
  });

  it("refuses a ref that is neither main nor a release branch, a branch with no candidate, and one past its final", () => {
    const root = workspace("0.85.0");
    branch(root, "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "feat/x"])),
      "Error: Publish final release runs on main or on a release/* branch in candidates; feat/x is neither.",
    );
    git(root, "switch", "-q", "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      'Error: release/0.84 has published no candidate yet. Merge its rc release PR ("chore(release): version") first, then finish.',
    );
    git(root, "tag", "modules-0.84-rc.1");
    const ok = script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^release=0\.84$/m);
    git(root, "tag", "v0.84.0");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      "Error: release/0.84 has published 0.84.0 and takes patches only.",
    );
  });
});

describe("Publish refusals", () => {
  it("refuses a frozen branch, naming the live one, and a ref that is no release branch", () => {
    const root = workspace("0.84.2");
    branch(root, "release/0.84");
    assert.equal(script(root, "release-branch.mjs", ["publish-check", "--ref", "release/0.84"]).status, 0);
    branch(root, "release/0.85");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["publish-check", "--ref", "release/0.84"])),
      "Error: release/0.84 is frozen: release/0.85 was cut from main. Land the fix on release/0.85.",
    );
    assert.equal(script(root, "release-branch.mjs", ["publish-check", "--ref", "release/0.85"]).status, 0);
    assert.equal(
      refused(script(root, "release-branch.mjs", ["publish-check", "--ref", "main"])),
      "Error: Publish runs on a release/* branch; main is not one.",
    );
  });
});

describe("release channel", () => {
  const outputs = (result) =>
    Object.fromEntries(result.stdout.trim().split("\n").filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const classify = (root, units, branchName = "release/0.85") =>
    outputs(script(root, "release-channel.mjs", ["classify"], { MOVED_UNITS: JSON.stringify(units), GITHUB_REF_NAME: branchName }));
  const line = (version) => [
    { key: "analyzer", name: "@telorun/analyzer", version, ecosystem: "npm" },
    { key: "cli", name: "@telorun/cli", version, ecosystem: "npm" },
  ];
  /** A release commit moving `units` in the ledger. */
  const versioned = (root, units) => {
    ledger(root, units);
    commit(root, "chore(release): version");
  };

  it("classifies a candidate, a final and a patch from the line's moved version", () => {
    const root = workspace("0.84.2");
    git(root, "switch", "-q", "-c", "release/0.85");
    versioned(root, { analyzer: "0.85.0-rc.1" });
    assert.deepEqual(classify(root, line("0.85.0-rc.1")), {
      channel: "candidate", version: "0.85.0-rc.1", tag: "v0.85.0-rc.1", "release-tag": "v0.85.0-rc.1", candidates: "true", "record-tag": "", released: "true",
    });
    versioned(root, { analyzer: "0.85.0" });
    assert.deepEqual(classify(root, line("0.85.0")), {
      channel: "final", version: "0.85.0", tag: "v0.85.0", "release-tag": "v0.85.0", candidates: "false", "record-tag": "v0.85.0", released: "true",
    });
    versioned(root, { analyzer: "0.85.1" });
    assert.equal(classify(root, line("0.85.1")).channel, "patch");
    assert.equal(classify(root, []).released, "false");
  });

  it("tags units released without the line packages-<x.y>-[rc.]<n>, and a modules-only release by its modules tag alone", () => {
    const root = workspace("0.85.0");
    git(root, "switch", "-q", "-c", "release/0.85");
    versioned(root, { "packages/glob": "0.3.3" });
    const glob = (version) => [{ key: "packages/glob", name: "@telorun/glob", version, ecosystem: "npm" }];
    const packages = classify(root, glob("0.3.3"));
    assert.deepEqual([packages.channel, packages["release-tag"], packages["record-tag"]], ["none", "packages-0.85-1", "packages-0.85-1"]);
    const candidate = classify(root, glob("0.3.3-rc.1"));
    assert.deepEqual([candidate["release-tag"], candidate["record-tag"], candidate.candidates], ["packages-0.85-rc.1", "", "true"]);
    const modules = classify(root, [{ key: "modules/a", name: "oci://ghcr.io/telorun/a", version: "1.1.0", ecosystem: "telo" }]);
    assert.deepEqual([modules["release-tag"], modules.released], ["", "true"]);

    git(root, "tag", "packages-0.85-1");
    versioned(root, { "packages/glob": "0.3.4" });
    assert.equal(classify(root, glob("0.3.4"))["release-tag"], "packages-0.85-2");
  });

  it("releases nothing at a later commit once a release tag names the release commit, and the same again at it", () => {
    const root = workspace("0.85.0");
    git(root, "switch", "-q", "-c", "release/0.85");
    versioned(root, { analyzer: "0.85.1" });
    put(root, "x.txt", "fix");
    commit(root, "fix: repair the pipeline");
    const first = classify(root, line("0.85.1"));
    assert.deepEqual([first.channel, first.tag, first.released], ["patch", "v0.85.1", "true"]);
    git(root, "tag", "v0.85.1", "HEAD^");
    assert.deepEqual([classify(root, line("0.85.1")).channel, classify(root, line("0.85.1")).released], ["none", "false"]);
    git(root, "switch", "-q", "--detach", "HEAD^");
    assert.equal(classify(root, line("0.85.1")).tag, "v0.85.1");
  });

  it("numbers a branch's module releases from the tags it already has, a candidate's apart, and reuses the one on HEAD", () => {
    const root = workspace("0.85.0");
    put(root, "m.txt", "1");
    commit(root, "modules 1");
    git(root, "tag", "modules-0.85-1");
    git(root, "tag", "modules-0.84-7");
    git(root, "tag", "modules-0.85-rc.1");
    put(root, "m.txt", "2");
    commit(root, "modules 2");
    const next = script(root, "release-channel.mjs", ["modules-tag"], { GITHUB_REF_NAME: "release/0.85" });
    assert.match(next.stdout, /^tag=modules-0\.85-2$/m);
    assert.match(next.stdout, /^existing=false$/m);
    assert.match(script(root, "release-channel.mjs", ["modules-tag"], { GITHUB_REF_NAME: "release/0.85", CANDIDATES: "true" }).stdout, /^tag=modules-0\.85-rc\.2$/m);
    git(root, "tag", "modules-0.85-2");
    const again = script(root, "release-channel.mjs", ["modules-tag"], { GITHUB_REF_NAME: "release/0.85" });
    assert.match(again.stdout, /^tag=modules-0\.85-2$/m);
    assert.match(again.stdout, /^existing=true$/m);
  });

  it("makes a GitHub Release latest only for a final or patch no higher release supersedes", async () => {
    const { githubReleaseFlags } = await import(pathToFileURL(join(REPO, "scripts/release-channel.mjs")).href);
    assert.deepEqual(githubReleaseFlags({ channel: "candidate", version: "0.85.0-rc.1", latestTag: "v0.84.2" }), {
      prerelease: true, makeLatest: "false",
    });
    assert.equal(githubReleaseFlags({ channel: "final", version: "0.85.0", latestTag: "v0.84.2" }).makeLatest, "true");
    assert.equal(githubReleaseFlags({ channel: "patch", version: "0.85.1", latestTag: "v0.86.0" }).makeLatest, "false");
  });
});

describe("release branch versioning and tags", () => {
  it("reads a branch's final as published once v<x.y>.0 exists", async () => {
    const root = workspace("0.85.0");
    git(root, "tag", "v0.85.0");
    const { finalPublished } = await import(pathToFileURL(join(REPO, "scripts/version-line.mjs")).href);
    assert.equal(finalPublished({ cwd: root, branch: "origin/release/0.85" }), true);
    assert.equal(finalPublished({ cwd: root, branch: "release/0.86" }), false);
  });

  it("creates a release tag once, and never moves one", async () => {
    const { ensureTag } = await import(pathToFileURL(join(REPO, "scripts/release-tag.mjs")).href);
    const root = workspace("0.85.0");
    const sha = git(root, "rev-parse", "HEAD");
    const created = [];
    const create = (tag) => {
      created.push(tag);
      git(root, "tag", tag);
    };
    assert.equal(ensureTag({ cwd: root, tag: "v0.85.0", sha, create }), "created");
    assert.equal(ensureTag({ cwd: root, tag: "v0.85.0", sha, create }), "exists");
    assert.deepEqual(created, ["v0.85.0"]);
    put(root, "x.txt", "x");
    commit(root, "later");
    assert.throws(() => ensureTag({ cwd: root, tag: "v0.85.0", sha: git(root, "rev-parse", "HEAD"), create }), /never moved/);
  });

  it("creates a release branch once, and never moves one", async () => {
    const { ensureBranch } = await import(pathToFileURL(join(REPO, "scripts/release-branch.mjs")).href);
    const remote = new Map();
    const refs = { have: (name) => remote.get(name), create: (name, sha) => remote.set(name, sha) };
    assert.equal(ensureBranch({ branch: "release/0.86", sha: "a1", ...refs }), "created");
    assert.equal(ensureBranch({ branch: "release/0.86", sha: "a1", ...refs }), "exists");
    assert.throws(() => ensureBranch({ branch: "release/0.86", sha: "b2", ...refs }), /^Error: release\/0\.86 already exists at a1, not at b2\.$/);
  });

  it("records the live branch's newest non-candidate tag, by history and then modules over packages over v", async () => {
    const { recordTagFor } = await import(pathToFileURL(join(REPO, "scripts/release-branch.mjs")).href);
    const root = workspace("0.85.0");
    git(root, "tag", "v0.84.2");
    git(root, "switch", "-q", "-c", "release/0.85");
    put(root, "x.txt", "1");
    commit(root, "0.85.0");
    git(root, "tag", "v0.85.0");
    git(root, "tag", "v0.85.1-rc.0");
    put(root, "x.txt", "2");
    commit(root, "patch and modules");
    git(root, "tag", "v0.85.1");
    git(root, "tag", "modules-0.85-1");
    git(root, "tag", "packages-0.85-1");
    git(root, "switch", "-q", "-c", "elsewhere", "main");
    put(root, "y.txt", "y");
    commit(root, "elsewhere");
    git(root, "tag", "v0.85.9");
    git(root, "switch", "-q", "main");

    assert.deepEqual(recordTagFor({ cwd: root, given: "v0.85.0" }), { tag: "modules-0.85-1", branch: "release/0.85" });
    assert.throws(() => recordTagFor({ cwd: root, given: "v0.85.1-rc.0" }), /v0\.85\.1-rc\.0 is a release candidate/);
    assert.throws(() => recordTagFor({ cwd: root, given: "v0.85.9" }), /v0\.85\.9 is not reachable from release\/0\.85/);
  });

  it("takes release check's refs from the event: HEAD for the release machinery and a push, the live branch as carrier on main", async () => {
    const { gateRefs } = await import(pathToFileURL(join(REPO, "scripts/release-branch.mjs")).href);
    const root = workspace("0.85.0");
    git(root, "branch", "release/0.85");
    assert.deepEqual(gateRefs({ cwd: root, event: "pull_request", base: "main", head: "feat/x" }), {
      base: "origin/main",
      carriedBy: "release/0.85",
    });
    for (const head of ["release-version/release/0.85", "release-record/release/0.85"]) {
      assert.equal(gateRefs({ cwd: root, event: "pull_request", base: "main", head }).base, "HEAD");
    }
    for (const head of ["module-release/release/0.85", "imports/release/0.85"]) {
      assert.equal(gateRefs({ cwd: root, event: "pull_request", base: "main", head }).base, "origin/main");
    }
    assert.deepEqual(gateRefs({ cwd: root, event: "pull_request", base: "release/0.85", head: "pick/x" }), {
      base: "origin/release/0.85",
      carriedBy: "",
    });
    assert.deepEqual(gateRefs({ cwd: root, event: "push", ref: "main" }), { base: "HEAD", carriedBy: "release/0.85" });
  });

});

// Stands in for `telo release imports --as=published -o json`: it pins every relative
// import (`A: ../../modules/a` → `A: oci://ghcr.io/telorun/a@1.1.0#sha256-A`) except
// the alias FAKE_KEEP names, which it keeps relative and exits 1, as the command does.
const FAKE_CLI = `
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_CWD_FILE) writeFileSync(process.env.FAKE_CWD_FILE, process.cwd());
const result = { ok: true, as: "published", dryRun: args.includes("--dry-run"), check: false, rewritten: [], keptRelative: [], errors: [] };
for (const manifest of args.filter((arg) => /\\.ya?ml$/.test(arg))) {
  const text = readFileSync(manifest, "utf8").replace(/^(  (\\w+): )(\\.\\.\\/\\S+)$/gm, (line, key, alias, source) => {
    if (alias === process.env.FAKE_KEEP) {
      result.keptRelative.push({ manifest, alias, source, cause: "plan-bumped", reason: "has an unreleased change" });
      return line;
    }
    const to = "oci://ghcr.io/telorun/" + basename(source) + "@1.1.0#sha256-" + alias;
    result.rewritten.push({ manifest, alias, source, to });
    return key + to;
  });
  const flowed = text.replace(/^imports: \\{(.*)\\}$/gm, (line, inner) =>
    "imports: {" + inner.replace(/(\\w+): (\\.\\.\\/[^,\\s}]+)/g, (entry, alias, source) => {
      const to = "oci://ghcr.io/telorun/" + basename(source) + "@1.1.0#sha256-" + alias;
      result.rewritten.push({ manifest, alias, source, to });
      return alias + ": " + to;
    }) + "}");
  if (!result.dryRun) writeFileSync(manifest, flowed);
}
if (process.env.FAKE_FAIL) process.exit(2);
result.ok = result.keptRelative.length === 0;
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
`;

function fakeCli() {
  const dir = mkdtempSync(join(tmpdir(), "telo-fake-cli-"));
  made.push(dir);
  writeFileSync(join(dir, "telo.mjs"), FAKE_CLI);
  return `${process.execPath} ${join(dir, "telo.mjs")}`;
}

const outputsOf = (result) =>
  Object.fromEntries(result.stdout.trim().split("\n").filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s).slice(0, 2)));

describe("publication commits", () => {
  const library = (name, version) => `kind: Telo.Library\nmetadata:\n  name: ${name}\n  version: ${version}\n`;
  const consumer = (source) => `kind: Telo.Application\nmetadata:\n  name: S\nimports:\n  A: ${source}\n`;
  const cli = fakeCli();
  // GH_TOKEN / GITHUB_REPOSITORY cleared: a push goes to the scratch repo's origin.
  const env = (extra = {}) => ({ TELO_CLI: cli, GH_TOKEN: "", GITHUB_REPOSITORY: "", ...extra });

  /** 0.85.0 shipped as a pre-change tag; release/0.85 checked out at its release commit
   *  `0.85.1`, which moves the CLI and module `a` and is consumed relatively by a starter. */
  function released() {
    const root = workspace("0.85.0");
    put(root, "telo-workspace.yaml", "release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n");
    put(root, "modules/a/telo.yaml", library("A", "1.0.0"));
    put(root, "starters/s/telo.yaml", consumer("../../modules/a"));
    ledger(root, { analyzer: "0.85.0", "modules/a": "1.0.0" });
    commit(root, "consumers");
    git(root, "switch", "-q", "-c", "release/0.85");
    git(root, "tag", "v0.85.0");
    put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version: "0.85.1" }));
    put(root, "modules/a/telo.yaml", library("A", "1.1.0"));
    put(root, "modules/a/CHANGELOG.md", "## 1.1.0\n");
    ledger(root, { analyzer: "0.85.1", "modules/a": "1.1.0" });
    commit(root, "chore(release): version");
    return { root, release: git(root, "rev-parse", "HEAD") };
  }

  const publish = (root, args, extra) => script(root, "publication-commit.mjs", args, env(extra));

  it("makes the same branchless commit twice, touching only import lines, with fixed identity and dates, leaving the checkout alone", async () => {
    const { isPublicationCommit } = await import(pathToFileURL(join(REPO, "scripts/release-commit.mjs")).href);
    const { PUBLICATION_IDENTITY } = await import(pathToFileURL(join(REPO, "scripts/publication-commit.mjs")).href);
    const { root, release } = released();
    const before = [git(root, "status", "--porcelain"), git(root, "worktree", "list")];

    const first = publish(root, ["--release", release, "--tag", "v0.85.1"]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = publish(root, ["--release", "release/0.85", "--tag", "v0.85.1", "--dry-run"]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const sha = outputsOf(first).sha;
    assert.equal(outputsOf(first).publication, "true");
    assert.equal(outputsOf(second).sha, sha);
    assert.equal(first.stdout.trim().split("\n").at(-1), sha);
    assert.match(second.stderr, /would tag v0\.85\.1 at [0-9a-f]{40} \(new\)/);
    assert.equal(git(root, "tag", "--list", "v0.85.1"), "");

    const { name, email } = PUBLICATION_IDENTITY;
    assert.equal(
      git(root, "log", "-1", "--date=raw", "--format=%an|%ae|%ad|%cn|%ce|%cd|%P|%B", sha),
      `${name}|${email}|${git(root, "log", "-1", "--date=raw", "--format=%cd", release)}|${name}|${email}|` +
        `${git(root, "log", "-1", "--date=raw", "--format=%cd", release)}|${release}|chore(release): publish v0.85.1`,
    );
    assert.equal(git(root, "branch", "--all", "--contains", sha), "");
    assert.equal(git(root, "diff", "--name-only", release, sha), "starters/s/telo.yaml");
    assert.equal(git(root, "show", `${sha}:starters/s/telo.yaml`), consumer("oci://ghcr.io/telorun/a@1.1.0#sha256-A").trim());
    assert.equal(isPublicationCommit({ cwd: root, commit: sha }), true);
    assert.deepEqual([git(root, "status", "--porcelain"), git(root, "worktree", "list")], before);
  });

  it("builds in the checkout itself and leaves it as it was, whether the rewrite succeeds or fails", () => {
    const { root, release } = released();
    const cwdFile = join(mkdtempSync(join(tmpdir(), "telo-cwd-")), "cwd");
    made.push(dirname(cwdFile));
    const worktrees = git(root, "worktree", "list");
    const ok = publish(root, ["--release", release, "--tag", "v0.85.1"], { FAKE_CWD_FILE: cwdFile });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(readFileSync(cwdFile, "utf8"), realpathSync(root));
    assert.deepEqual([git(root, "status", "--porcelain"), git(root, "diff", "--cached", "--name-only"), git(root, "worktree", "list")], ["", "", worktrees]);

    const failed = publish(root, ["--release", release, "--tag", "v0.85.1"], { FAKE_FAIL: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /telo release imports exited 2 and named no import/);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(root, "starters/s/telo.yaml"), "utf8"), consumer("../../modules/a"));
  });

  it("accepts a flow-style `imports: { … }` line as an import line respelled", async () => {
    const { isPublicationCommit } = await import(pathToFileURL(join(REPO, "scripts/release-commit.mjs")).href);
    const { root } = released();
    put(root, "starters/f/telo.yaml", "kind: Telo.Application\nmetadata:\n  name: F\nimports: { A: ../../modules/a }\n");
    commit(root, "chore(release): version, flow");
    const release = git(root, "rev-parse", "HEAD");
    const result = publish(root, ["--release", release, "--tag", "v0.85.1"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const sha = outputsOf(result).sha;
    assert.equal(git(root, "diff", "--name-only", release, sha), "starters/f/telo.yaml\nstarters/s/telo.yaml");
    assert.match(git(root, "show", `${sha}:starters/f/telo.yaml`), /^imports: \{ A: oci:\/\/ghcr\.io\/telorun\/a@1\.1\.0#sha256-A \}$/m);
    assert.equal(isPublicationCommit({ cwd: root, commit: sha }), true);
  });

  it("refuses a checkout that is not the release commit as published, naming why", () => {
    const { root, release } = released();
    const refuse = (extra = {}) => publish(root, ["--release", release, "--tag", "v0.85.1"], extra);

    put(root, "modules/a/telo.yaml", library("A", "1.1.1"));
    const dirty = refuse();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /the checkout has changes to tracked files \(modules\/a\/telo\.yaml\)/);
    git(root, "checkout", "--", "modules/a/telo.yaml");

    put(root, "starters/new/telo.yaml", consumer("../../modules/a"));
    const untracked = refuse();
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /untracked files under examples, starters, apps, blueprints \(starters\/new\/telo\.yaml\)/);
    rmSync(join(root, "starters/new"), { recursive: true });

    put(root, "x.txt", "later");
    commit(root, "fix: later");
    const moved = refuse();
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, new RegExp(`HEAD is [0-9a-f]{40}, not the release commit ${release}: check out ${release}, install and build it, and run again`));
    assert.equal(git(root, "status", "--porcelain"), "");
  });

  it("pushes the tag with the branchless commit to the remote once, and finds it there on a re-run", () => {
    const { root, release } = released();
    const remote = mkdtempSync(join(tmpdir(), "telo-remote-"));
    made.push(remote);
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "release/0.85");

    const pushed = publish(root, ["--release", release, "--tag", "v0.85.1", "--tag", "modules-0.85-1", "--push"]);
    assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
    const sha = outputsOf(pushed).sha;
    assert.match(pushed.stderr, /v0\.85\.1 created at/);
    assert.match(pushed.stderr, /modules-0\.85-1 created at/);
    for (const tag of ["v0.85.1", "modules-0.85-1"]) {
      assert.equal(git(remote, "rev-parse", `refs/tags/${tag}`), sha);
      assert.equal(git(root, "rev-parse", `refs/tags/${tag}`), sha);
    }
    assert.equal(git(remote, "log", "-1", "--format=%s", sha), "chore(release): publish v0.85.1");

    const again = publish(root, ["--release", release, "--tag", "v0.85.1", "--tag", "modules-0.85-1", "--push"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(outputsOf(again).sha, sha);
    assert.match(again.stderr, /v0\.85\.1 exists at/);
  });

  it("makes a candidate's publication commit like a final's, and fails naming an import left relative", () => {
    const { root, release } = released();
    const candidate = publish(root, ["--release", release, "--tag", "v0.85.1-rc.1", "--dry-run"]);
    assert.equal(candidate.status, 0, candidate.stdout + candidate.stderr);

    const kept = publish(root, ["--release", release, "--tag", "v0.85.1"], { FAKE_KEEP: "A" });
    assert.equal(kept.status, 1);
    assert.match(kept.stderr, /1 import\(s\) would not be published:\n {2}starters\/s\/telo\.yaml {2}A: \.\.\/\.\.\/modules\/a {2}has an unreleased change/);
  });

  it("makes no publication commit when nothing is rewritten: the tag names the release commit", () => {
    const { root } = released();
    put(root, "starters/s/telo.yaml", consumer("oci://ghcr.io/telorun/a@1.1.0#sha256-A"));
    commit(root, "chore(release): version, pinned");
    const release = git(root, "rev-parse", "HEAD");
    const result = publish(root, ["--release", release, "--tag", "v0.85.1"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual([outputsOf(result).publication, outputsOf(result).sha], ["false", release]);
    assert.match(result.stderr, /the rewrite changes nothing/);
  });

  it("reads a tag's release commit: the parent of a publication commit, else the commit itself", async () => {
    const { releaseCommitOf, isPublicationCommit, tagsOfReleaseCommit } = await import(
      pathToFileURL(join(REPO, "scripts/release-commit.mjs")).href
    );
    const { root, release } = released();
    const sha = outputsOf(publish(root, ["--release", release, "--tag", "v0.85.1"])).sha;
    git(root, "tag", "v0.85.1", sha);
    git(root, "tag", "modules-0.85-1", sha);
    assert.equal(releaseCommitOf({ cwd: root, tag: "v0.85.1" }), release);
    assert.equal(releaseCommitOf({ cwd: root, tag: "v0.85.0" }), git(root, "rev-parse", "v0.85.0"));
    assert.deepEqual(tagsOfReleaseCommit({ cwd: root, commit: release }), ["modules-0.85-1", "v0.85.1"]);
    for (const commit_ of [sha, release]) {
      assert.equal(outputsOf(script(root, "release-commit.mjs", [commit_]))["release-commit"], release);
    }

    // The right subject over a change that is not an import line respelled.
    const forged = (edit, subject) => {
      git(root, "switch", "-q", "--detach", release);
      edit();
      commit(root, subject);
      const at = git(root, "rev-parse", "HEAD");
      git(root, "switch", "-q", "release/0.85");
      return at;
    };
    const version = forged(() => put(root, "starters/s/telo.yaml", consumer("../../modules/a").replace("name: S", "name: T")), "chore(release): publish v0.85.2");
    const outside = forged(() => put(root, "modules/a/telo.yaml", library("A", "1.2.0")), "chore(release): publish v0.85.2");
    const subject = forged(() => put(root, "starters/s/telo.yaml", consumer("oci://ghcr.io/telorun/a@1.1.0#sha256-A")), "fix: pin");
    for (const commit_ of [version, outside, subject]) assert.equal(isPublicationCommit({ cwd: root, commit: commit_ }), false);
    git(root, "tag", "v0.85.2", outside);
    assert.equal(releaseCommitOf({ cwd: root, tag: "v0.85.2" }), outside);
  });

  it("records a tag on a publication commit from its release commit, and the cut waits for that record", async () => {
    const { recordTagFor } = await import(pathToFileURL(join(REPO, "scripts/release-branch.mjs")).href);
    const { root, release } = released();
    const sha = outputsOf(publish(root, ["--release", release, "--tag", "v0.85.1"])).sha;
    git(root, "tag", "v0.85.1", sha);
    git(root, "tag", "modules-0.85-1", sha);
    git(root, "switch", "-q", "main");
    linePlan(root, "0.86.0", "minor");
    commit(root, "feat on main");

    assert.deepEqual(recordTagFor({ cwd: root, given: "v0.85.1" }), { tag: "modules-0.85-1", branch: "release/0.85" });
    const cut = () => script(root, "release-branch.mjs", ["cut-check", "--ref", "main"], {}, BUN);
    assert.equal(
      refused(cut()),
      'Error: main does not record modules-0.85-1. Merge "chore(release): record modules-0.85-1 on main" first.',
    );
    const plan = recordPlanOf(root, "modules-0.85-1");
    assert.equal(plan.writes["modules/a/telo.yaml"], library("A", "1.1.0"));
    assert.equal(Object.values(plan.writes).some((text) => text.includes("oci://")), false);
    applyRecord(root, "modules-0.85-1");
    commit(root, "chore(release): record modules-0.85-1 on main");
    assert.equal(git(root, "show", "HEAD:starters/s/telo.yaml"), consumer("../../modules/a").trim());
    const result = cut();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("classifies a re-run at a release commit whose tags sit on its publication commit as the first run, and numbers on from them", () => {
    const { root, release } = released();
    const branchEnv = { GITHUB_REF_NAME: "release/0.85", MOVED_UNITS: JSON.stringify([{ key: "analyzer", name: "@telorun/analyzer", version: "0.85.1", ecosystem: "npm" }, { key: "modules/a", name: "oci://ghcr.io/telorun/a", version: "1.1.0", ecosystem: "telo" }]) };
    const first = outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv));
    const sha = outputsOf(publish(root, ["--release", release, "--tag", "v0.85.1"])).sha;
    git(root, "tag", "v0.85.1", sha);
    git(root, "tag", "modules-0.85-1", sha);

    assert.deepEqual(outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv)), first);
    assert.equal(first.tag, "v0.85.1");
    assert.equal(first.channel, "patch");
    const again = outputsOf(script(root, "release-channel.mjs", ["modules-tag"], branchEnv));
    assert.deepEqual([again.tag, again.existing], ["modules-0.85-1", "true"]);

    put(root, "x.txt", "fix");
    commit(root, "fix");
    const next = outputsOf(script(root, "release-channel.mjs", ["modules-tag"], branchEnv));
    assert.deepEqual([next.tag, next.existing], ["modules-0.85-2", "false"]);
  });

  it("releases the version commit a fix was pushed on top of, until a tag names a release", () => {
    const { root } = released();
    const branchEnv = { GITHUB_REF_NAME: "release/0.85", MOVED_UNITS: JSON.stringify([{ key: "analyzer", name: "@telorun/analyzer", version: "0.85.1", ecosystem: "npm" }, { key: "modules/a", name: "oci://ghcr.io/telorun/a", version: "1.1.0", ecosystem: "telo" }]) };
    put(root, "x.txt", "fix");
    commit(root, "fix: repair the pipeline");
    const first = outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv));
    assert.deepEqual([first.channel, first.tag, first["record-tag"]], ["patch", "v0.85.1", "v0.85.1"]);

    const tip = git(root, "rev-parse", "HEAD");
    const sha = outputsOf(publish(root, ["--release", tip, "--tag", "v0.85.1"])).sha;
    git(root, "tag", "v0.85.1", sha);
    assert.deepEqual(outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv)), first);

    put(root, "y.txt", "next fix");
    commit(root, "fix: later");
    assert.equal(outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv)).channel, "none");
  });

  it("does not read a record's ledger beneath a fix as a release commit", async () => {
    const { releaseCommit } = await import(pathToFileURL(join(REPO, "scripts/release-units.mjs")).href);
    const root = workspace("0.85.0");
    git(root, "switch", "-q", "-c", "release/0.86");
    ledger(root, { analyzer: "0.85.1" });
    commit(root, "chore(release): record v0.85.1 on main");
    put(root, "x.txt", "fix");
    commit(root, "fix");
    assert.equal(releaseCommit({ cwd: root }), undefined);
  });

  it("gates the release PR on imports awaiting this release's publish only", async () => {
    const { releaseImportsVerdict } = await import(pathToFileURL(join(REPO, "scripts/check-release-imports.mjs")).href);
    const kept = (alias, cause) => ({ manifest: "starters/s/telo.yaml", alias, source: `../../modules/${alias}`, cause, reason: cause });
    const envelope = (keptRelative, errors = []) => ({ ok: false, keptRelative, errors });
    assert.deepEqual(releaseImportsVerdict({ status: 0, result: envelope([]) }).failures, []);
    const awaiting = releaseImportsVerdict({ status: 1, result: envelope([kept("a", "unpublished"), kept("b", "never-released")]) });
    assert.deepEqual([awaiting.failures, awaiting.awaiting.length], [[], 2]);
    assert.deepEqual(releaseImportsVerdict({ status: 1, result: envelope([kept("a", "unpublished"), kept("c", "plan-bumped")]) }).failures, [
      "starters/s/telo.yaml  c: ../../modules/c  plan-bumped",
    ]);
    assert.deepEqual(
      releaseImportsVerdict({ status: 1, result: envelope([], [{ manifest: "apps/x/telo.yaml", message: "registry unreachable" }]) }).failures,
      ["apps/x/telo.yaml  registry unreachable"],
    );
    assert.equal(releaseImportsVerdict({ status: 1, result: { ok: false } }).failures.length, 1);
    assert.equal(releaseImportsVerdict({ status: 2, result: undefined }).failures.length, 1);
  });
});

describe("the record of a release on main", () => {
  it("copies the tag's unit versions into every package, its changelogs and ledger entries for what main holds, deletes what the tag released, and carries the floors the release resolved", () => {
    const manifest = (name, version, floor) =>
      `kind: Telo.Library\nmetadata:\n  name: ${name}\n  version: ${version}\nrequires:\n  telo: "${floor}"\n`;
    const entries = (list) =>
      `units:\n${list.map(([key, version]) => `  ${key}:\n    version: ${version}\n    layers:\n      telo:\n        .:\n          manifest: sha256-${version.replaceAll(".", "")}\n`).join("")}`;
    const root = workspace("0.84.2");
    put(
      root,
      "telo-workspace.yaml",
      "release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n    - { path: cli, ecosystem: { npm: nodejs }, version: nodejs/package.json }\n",
    );
    put(root, "cli/CHANGELOG.md", "# Changelog\n");
    put(root, "modules/a/telo.yaml", manifest("A", "1.0.0", ">=unreleased"));
    put(root, ".changes/ledger.yaml", entries([["modules/a", "1.0.0"]]));
    put(root, ".changes/pending/one.yaml", "x\n");
    commit(root, "feat");

    git(root, "switch", "-q", "-c", "release/0.85");
    rmSync(join(root, ".changes/pending/one.yaml"));
    put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version: "0.85.0" }));
    put(root, "cli/CHANGELOG.md", "# Changelog\n\n## 0.85.0\n");
    put(root, "modules/a/telo.yaml", manifest("A", "1.1.0", ">=0.85.0"));
    put(root, "modules/a/CHANGELOG.md", "## 1.1.0\n");
    put(root, "modules/gone/telo.yaml", manifest("Gone", "2.0.0", ">=0.85.0"));
    put(root, "modules/gone/CHANGELOG.md", "## 2.0.0\n");
    put(root, ".changes/ledger.yaml", entries([["modules/a", "1.1.0"], ["modules/gone", "2.0.0"]]));
    commit(root, "chore(release): version");
    git(root, "tag", "modules-0.85-1");

    git(root, "switch", "-q", "main");
    put(root, ".changes/pending/one.yaml", "x\n");
    put(root, ".changes/pending/other.yaml", "main's own\n");
    commit(root, "work on main after the cut");

    const plan = recordPlanOf(root, "modules-0.85-1");
    assert.deepEqual(plan.deletions, [".changes/pending/one.yaml"]);
    assert.deepEqual(Object.keys(plan.writes).sort(), [
      ".changes/ledger.yaml",
      "cli/CHANGELOG.md",
      "cli/nodejs/package.json",
      "modules/a/CHANGELOG.md",
      "modules/a/telo.yaml",
    ]);
    assert.equal(plan.writes["modules/a/telo.yaml"], manifest("A", "1.1.0", ">=0.85.0"));
    assert.match(plan.writes["cli/nodejs/package.json"], /"version":"0\.85\.0"/);
    assert.equal(plan.writes[".changes/ledger.yaml"].includes("modules/gone"), false);
    assert.match(plan.writes[".changes/ledger.yaml"], /modules\/a:\n {4}version: 1\.1\.0/);
  });

  describe("a record's `>=unreleased` floors", () => {
    const manifest = (version, floor, restriction, reason = "needs a feature") =>
      `kind: Telo.Library\nmetadata:\n  name: A\n  version: ${version}\nrequires:\n  telo: "${floor}"\nrestrictions:\n  - requires: { telo: "${restriction}" }\n    reason: ${reason}\n`;

    /** 0.85.x released from a branch cut off main, which then gained `pending` fragments and `mainManifest`. */
    function recorded({ pending = {}, tagged = manifest("1.1.0", ">=0.85.0", ">=0.85.0"), cli = "0.85.0", mainManifest } = {}) {
      const root = workspace("0.84.2");
      put(root, "telo-workspace.yaml", "release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n");
      put(root, "modules/a/telo.yaml", manifest("1.0.0", ">=unreleased", ">=unreleased"));
      put(root, ".changes/pending/next.yaml", "units:\n  modules/a: Added\nbody: next\n");
      commit(root, "feat");
      git(root, "switch", "-q", "-c", "release/0.85");
      rmSync(join(root, ".changes/pending/next.yaml"));
      put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version: cli }));
      put(root, "modules/a/telo.yaml", tagged);
      commit(root, "chore(release): version");
      git(root, "tag", "modules-0.85-1");
      git(root, "switch", "-q", "main");
      for (const [id, units] of Object.entries(pending)) {
        put(root, `.changes/pending/${id}.yaml`, `units:\n${units.map((key) => `  ${key}: Fixed`).join("\n")}\nbody: main only\n`);
      }
      if (mainManifest) put(root, "modules/a/telo.yaml", mainManifest);
      if (Object.keys(pending).length > 0 || mainManifest) commit(root, "work on main after the cut");
      return root;
    }

    it("take the bound the tag holds at the same place, in requires and in a restriction", () => {
      const plan = recordPlanOf(recorded(), "modules-0.85-1");
      assert.equal(plan.writes["modules/a/telo.yaml"], manifest("1.1.0", ">=0.85.0", ">=0.85.0"));
    });

    it("take it whatever fragments main still holds pending", () => {
      for (const pending of [{ other: ["modules/b"] }, { own: ["modules/a"] }]) {
        const plan = recordPlanOf(recorded({ pending }), "modules-0.85-1");
        assert.equal(plan.writes["modules/a/telo.yaml"], manifest("1.1.0", ">=0.85.0", ">=0.85.0"));
      }
    });

    it("take the tag's own bound, not the tag's version, so a patch release does not narrow a restriction", () => {
      const root = recorded({ cli: "0.85.1", tagged: manifest("1.1.0", ">=0.85.0", ">=0.85.0") });
      const plan = recordPlanOf(root, "modules-0.85-1");
      assert.equal(plan.writes["modules/a/telo.yaml"], manifest("1.1.0", ">=0.85.0", ">=0.85.0"));
    });

    it("stay where the tag also left `>=unreleased`, and for a restriction main gave another reason", () => {
      const stillUnreleased = recorded({ tagged: manifest("1.1.0", ">=unreleased", ">=unreleased") });
      assert.equal(recordPlanOf(stillUnreleased, "modules-0.85-1").writes["modules/a/telo.yaml"], manifest("1.1.0", ">=unreleased", ">=unreleased"));

      const reworded = recorded({ mainManifest: manifest("1.0.0", ">=unreleased", ">=unreleased", "main's own reason") });
      assert.equal(
        recordPlanOf(reworded, "modules-0.85-1").writes["modules/a/telo.yaml"],
        manifest("1.1.0", ">=0.85.0", ">=unreleased", "main's own reason"),
      );
    });

    it("leave nothing to record once applied", () => {
      const root = recorded();
      applyRecord(root, "modules-0.85-1");
      assert.equal(recordPlanOf(root, "modules-0.85-1").writes["modules/a/telo.yaml"], undefined);
    });
  });
});
