// The release-branch scripts — live branch, the Cut / Finish / Publish refusals,
// channel classification, the names a release gets and the record of a release on
// main — each run against a scratch git repository holding copies of the scripts
// (and links to the analyzer and CLI sources the record reads under bun).
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
// The record reads the analyzer and the CLI's release modules from source.
const SOURCES = ["analyzer/nodejs/src", "analyzer/nodejs/node_modules", "cli/nodejs/src", "cli/nodejs/node_modules"];
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
  for (const dir of SOURCES) symlinkSync(join(REPO, dir), join(root, dir));
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

function changeset(root, id, bump) {
  put(root, `.changeset/${id}.md`, `---\n"@telorun/cli": ${bump}\n---\n\nchange\n`);
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
  changeset(root, "next", "minor");
  commit(root, "feat on main");
  return root;
}

describe("Start release candidates refusals", () => {
  it("refuses off main", () => {
    const root = timeline();
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "feat/x"]);
    assert.equal(refused(result), "Error: Start release candidates runs on main; feat/x is not main.");
  });

  it("passes with no release branch and names the minor main plans", () => {
    const root = workspace("0.84.2");
    changeset(root, "next", "minor");
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "main"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^release=0\.85$/m);
  });

  it("refuses while the live branch is in candidates", () => {
    const root = workspace("0.84.2");
    branch(root, "release/0.85", () => {
      put(root, ".changeset/pre.json", '{"mode":"pre","tag":"rc","initialVersions":{},"changesets":[]}');
      put(root, "cli/nodejs/package.json", '{"name":"@telorun/cli","version":"0.85.0-rc.1"}');
    });
    changeset(root, "next", "minor");
    commit(root, "feat");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.",
    );
  });

  it("refuses while the live branch holds a changeset or fragment", () => {
    const root = workspace("0.85.0");
    branch(root, "release/0.85", () => changeset(root, "quiet-lamps-glow", "patch"));
    changeset(root, "next", "minor");
    commit(root, "feat");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: release/0.85 holds unreleased changes (.changeset/quiet-lamps-glow.md). Publish them before cutting 0.86.",
    );
  });

  it("refuses until main records the live branch's newest release tag", () => {
    const root = timeline();
    const module = (version) => `kind: Telo.Library\nmetadata:\n  name: A\n  version: ${version}\n`;
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n");
    put(root, "modules/a/telo.yaml", module("1.0.0"));
    commit(root, "module on main");
    git(root, "switch", "-q", "release/0.85");
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n");
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

  it("refuses when main plans only a patch", () => {
    const root = workspace("0.85.0");
    changeset(root, "small", "patch");
    commit(root, "fix");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      "Error: main's changesets plan 0.85.1, a patch. Add a minor changeset before cutting.",
    );
  });
});

describe("Publish final release refusals", () => {
  it("on main, accepts what the cut accepts and names the branch it cuts straight to the final", () => {
    const root = workspace("0.84.2");
    changeset(root, "next", "minor");
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
      put(candidates, ".changeset/pre.json", '{"mode":"pre","tag":"rc","initialVersions":{},"changesets":[]}');
      put(candidates, "cli/nodejs/package.json", '{"name":"@telorun/cli","version":"0.85.0-rc.1"}');
    });
    changeset(candidates, "next", "minor");
    commit(candidates, "feat");
    assert.equal(finish(candidates), "Error: release/0.85 is in candidates (0.85.0-rc.1). Finish it before cutting 0.86.");

    const existing = workspace("0.84.2");
    branch(existing, "release/0.85");
    changeset(existing, "next", "minor");
    commit(existing, "feat");
    assert.equal(
      finish(existing),
      "Error: release/0.85 already exists. Land the change on it, or add a changeset for the next minor.",
    );

    const patch = workspace("0.85.0");
    changeset(patch, "small", "patch");
    commit(patch, "fix");
    assert.equal(finish(patch), "Error: main's changesets plan 0.85.1, a patch. Add a minor changeset before cutting.");
  });

  it("refuses a ref that is neither main nor a release branch, and a branch with no pre.json, and accepts one in candidates or past pre exit", () => {
    const root = workspace("0.85.0");
    branch(root, "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "feat/x"])),
      "Error: Publish final release runs on main or on a release/* branch in candidates; feat/x is neither.",
    );
    git(root, "switch", "-q", "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      'Error: release/0.84 has published no candidate yet. Merge its rc Version PR ("chore(release): version") first, then finish.',
    );
    git(root, "tag", "v0.84.0");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      "Error: release/0.84 has published 0.84.0 and takes patches only.",
    );
    git(root, "tag", "-d", "v0.84.0");
    put(root, ".changeset/pre.json", '{"mode":"exit","tag":"rc","initialVersions":{},"changesets":[]}');
    assert.equal(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"]).status, 0);
    put(root, ".changeset/pre.json", '{"mode":"pre","tag":"rc","initialVersions":{},"changesets":[]}');
    const ok = script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"]);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^release=0\.84$/m);
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
  const classify = (root, published = "[]") =>
    Object.fromEntries(
      script(root, "release-channel.mjs", ["classify"], { PUBLISHED_PACKAGES: published })
        .stdout.trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  const release = (root, version, pre) => {
    put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version }));
    if (pre) put(root, ".changeset/pre.json", `{"mode":"${pre}","tag":"rc","initialVersions":{},"changesets":[]}`);
    else rmSync(join(root, ".changeset/pre.json"), { force: true });
    commit(root, `release ${version}`);
  };

  it("classifies a candidate, a final and a patch from the commit's CLI version", () => {
    const root = workspace("0.84.2");
    release(root, "0.85.0-rc.1", "pre");
    assert.deepEqual(classify(root), {
      channel: "candidate", version: "0.85.0-rc.1", tag: "v0.85.0-rc.1", "release-tag": "v0.85.0-rc.1", candidates: "true", "record-tag": "",
    });
    release(root, "0.85.0");
    assert.deepEqual(classify(root), {
      channel: "final", version: "0.85.0", tag: "v0.85.0", "release-tag": "v0.85.0", candidates: "false", "record-tag": "v0.85.0",
    });
    release(root, "0.85.1");
    assert.equal(classify(root).channel, "patch");
  });

  it("classifies a branch cut at main's record of another commit's release as none, and that release's own commit as it", () => {
    const root = workspace("0.85.0");
    git(root, "switch", "-q", "-c", "release/0.85");
    release(root, "0.85.1");
    git(root, "tag", "v0.85.1");
    git(root, "switch", "-q", "main");
    put(root, "x.txt", "main");
    release(root, "0.85.1");
    git(root, "switch", "-q", "-c", "release/0.86");
    const outputs = (result) =>
      Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const env = { GITHUB_REF_NAME: "release/0.86", PUBLISHED_PACKAGES: "[]" };
    assert.deepEqual(outputs(script(root, "release-channel.mjs", ["classify"], env)), {
      channel: "none", version: "", tag: "", "release-tag": "", candidates: "false", "record-tag": "",
    });
    assert.match(script(root, "release-channel.mjs", ["pack-tag"], env).stdout, /^tag=packages-0\.86-1$/m);
    git(root, "switch", "-q", "release/0.85");
    assert.equal(outputs(script(root, "release-channel.mjs", ["classify"], { GITHUB_REF_NAME: "release/0.85" })).tag, "v0.85.1");
  });

  it("tags packages published without the CLI packages-<x.y>-<n>, known before publishing", () => {
    const root = workspace("0.85.0");
    git(root, "switch", "-q", "-c", "release/0.85");
    put(root, "x.txt", "x");
    commit(root, "fix");
    const env = { GITHUB_REF_NAME: "release/0.85" };
    const classifyOn = (published) =>
      Object.fromEntries(
        script(root, "release-channel.mjs", ["classify"], { PUBLISHED_PACKAGES: published, ...env })
          .stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
    assert.match(script(root, "release-channel.mjs", ["pack-tag"], env).stdout, /^tag=packages-0\.85-1$/m);
    assert.equal(classifyOn("[]").channel, "none");
    assert.equal(classifyOn("[]")["release-tag"], "");
    const others = classifyOn('[{"name":"@telorun/runner-core","version":"1.0.1"}]');
    assert.equal(others.channel, "none");
    assert.equal(others["release-tag"], "packages-0.85-1");
    assert.equal(others["record-tag"], "packages-0.85-1");

    git(root, "tag", "packages-0.85-1");
    put(root, "x.txt", "y");
    commit(root, "more");
    assert.match(script(root, "release-channel.mjs", ["pack-tag"], env).stdout, /^tag=packages-0\.85-2$/m);
    git(root, "tag", "packages-0.85-2");
    assert.match(script(root, "release-channel.mjs", ["pack-tag"], env).stdout, /^tag=packages-0\.85-2$/m);
  });

  it("numbers a branch's module releases from the tags it already has, and reuses the one on HEAD", () => {
    const root = workspace("0.85.0");
    put(root, "m.txt", "1");
    commit(root, "modules 1");
    git(root, "tag", "modules-0.85-1");
    git(root, "tag", "modules-0.84-7");
    put(root, "m.txt", "2");
    commit(root, "modules 2");
    const next = script(root, "release-channel.mjs", ["modules-tag"], { GITHUB_REF_NAME: "release/0.85" });
    assert.match(next.stdout, /^tag=modules-0\.85-2$/m);
    assert.match(next.stdout, /^existing=false$/m);
    git(root, "tag", "modules-0.85-2");
    const again = script(root, "release-channel.mjs", ["modules-tag"], { GITHUB_REF_NAME: "release/0.85" });
    assert.match(again.stdout, /^tag=modules-0\.85-2$/m);
    assert.match(again.stdout, /^existing=true$/m);
  });

  it("versions no modules in candidates or while changesets are pending", () => {
    const root = workspace("0.85.0");
    assert.match(script(root, "release-channel.mjs", ["modules-ready"]).stdout, /^ready=true$/m);
    changeset(root, "p", "patch");
    assert.match(script(root, "release-channel.mjs", ["modules-ready"]).stdout, /^ready=false$/m);
    rmSync(join(root, ".changeset/p.md"));
    put(root, ".changeset/pre.json", '{"mode":"pre","tag":"rc","initialVersions":{},"changesets":[]}');
    assert.match(script(root, "release-channel.mjs", ["modules-ready"]).stdout, /^ready=false$/m);
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
  it("enters candidates only on a branch with no pre.json and no final tag", async () => {
    const { needsCandidateEntry } = await import(pathToFileURL(join(REPO, "scripts/release-version.mjs")).href);
    const root = workspace("0.85.0");
    assert.equal(needsCandidateEntry({ cwd: root, branch: "release/0.85" }), true);
    put(root, ".changeset/pre.json", "{}");
    assert.equal(needsCandidateEntry({ cwd: root, branch: "release/0.85" }), false);
    rmSync(join(root, ".changeset/pre.json"));
    git(root, "tag", "v0.85.0");
    assert.equal(needsCandidateEntry({ cwd: root, branch: "release/0.85" }), false);
    assert.equal(needsCandidateEntry({ cwd: root, branch: "release/0.86" }), true);
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
    for (const head of ["changeset-release/release/0.85", "release-record/release/0.85"]) {
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
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n");
    put(root, "modules/a/telo.yaml", library("A", "1.0.0"));
    put(root, "starters/s/telo.yaml", consumer("../../modules/a"));
    commit(root, "consumers");
    git(root, "switch", "-q", "-c", "release/0.85");
    git(root, "tag", "v0.85.0");
    put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version: "0.85.1" }));
    put(root, "modules/a/telo.yaml", library("A", "1.1.0"));
    put(root, "modules/a/CHANGELOG.md", "## 1.1.0\n");
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

  it("refuses a candidate, and fails naming an import left relative", () => {
    const { root, release } = released();
    const candidate = publish(root, ["--release", release, "--tag", "v0.85.1-rc.0", "--push"]);
    assert.equal(candidate.status, 1);
    assert.match(candidate.stderr, /v0\.85\.1-rc\.0 is a release candidate, which has no publication commit: its tag stays on the release commit\./);

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
    changeset(root, "next", "minor");
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
    const branchEnv = { GITHUB_REF_NAME: "release/0.85", PUBLISHED_PACKAGES: "[]" };
    const first = outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv));
    const sha = outputsOf(publish(root, ["--release", release, "--tag", "v0.85.1"])).sha;
    git(root, "tag", "v0.85.1", sha);
    git(root, "tag", "modules-0.85-1", sha);

    assert.deepEqual(outputsOf(script(root, "release-channel.mjs", ["classify"], branchEnv)), first);
    assert.equal(first.tag, "v0.85.1");
    assert.equal(first.channel, "patch");
    assert.match(script(root, "release-channel.mjs", ["pack-tag"], branchEnv).stdout, /^tag=v0\.85\.1$/m);
    const again = outputsOf(script(root, "release-channel.mjs", ["modules-tag"], branchEnv));
    assert.deepEqual([again.tag, again.existing], ["modules-0.85-1", "true"]);

    put(root, "x.txt", "fix");
    commit(root, "fix");
    const next = outputsOf(script(root, "release-channel.mjs", ["modules-tag"], branchEnv));
    assert.deepEqual([next.tag, next.existing], ["modules-0.85-2", "false"]);
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

const CHANGESET = join(REPO, "node_modules", ".bin", "changeset");

function changesetCli(root, ...args) {
  const result = spawnSync(CHANGESET, args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const cliVersion = (root) => JSON.parse(readFileSync(join(root, "cli/nodejs/package.json"), "utf8")).version;

describe("two-PR release flow", () => {
  it("enters candidates on a branch's first Version PR, exits when the open PR's head lost pre.json, and versions an rc again once it is closed", async () => {
    const { prereleaseAction, versionPrHeadLacksPre } = await import(pathToFileURL(join(REPO, "scripts/release-version.mjs")).href);
    const root = workspace("0.84.2");
    changeset(root, "next", "minor");
    commit(root, "feat");
    git(root, "switch", "-q", "-c", "release/0.85");
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85" }), "enter");

    changesetCli(root, "pre", "enter", "rc");
    changesetCli(root, "version");
    commit(root, "rc.0");
    assert.equal(cliVersion(root), "0.85.0-rc.0");
    changeset(root, "fix", "patch");
    commit(root, "fix");

    // An open rc Version PR keeps pre.json: the next version is an rc.
    const head = "refs/remotes/origin/changeset-release/release/0.85";
    git(root, "update-ref", head, "HEAD");
    const lacks = () => versionPrHeadLacksPre({ cwd: root, branch: "release/0.85" });
    assert.equal(lacks(), false);
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", openPr: true, headLacksPre: lacks }), "none");

    // The final Version PR's head has no pre.json: rebuilds exit again.
    git(root, "switch", "-q", "--detach", "HEAD");
    changesetCli(root, "pre", "exit");
    changesetCli(root, "version");
    assert.equal(cliVersion(root), "0.85.0");
    assert.ok(!existsSync(join(root, ".changeset/pre.json")));
    commit(root, "chore(release): version packages");
    git(root, "update-ref", head, "HEAD");
    git(root, "switch", "-q", "release/0.85");
    assert.equal(lacks(), true);
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", openPr: true, headLacksPre: lacks }), "exit");

    // Closed: no open PR, back to candidates.
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", openPr: false, headLacksPre: lacks }), "none");
    // Finish itself always exits a branch in candidates.
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", final: true }), "exit");
  });

  it("Publish final release over an open rc Version PR produces the final carrying the rc's changesets", () => {
    const root = workspace("0.84.2");
    put(root, "package.json", '{"name":"root","private":true,"version":"1.0.0","scripts":{"version-packages":"changeset version"}}');
    changeset(root, "next", "minor");
    commit(root, "feat");
    git(root, "switch", "-q", "-c", "release/0.85");
    changesetCli(root, "pre", "enter", "rc");
    changesetCli(root, "version");
    commit(root, "rc.0");
    changeset(root, "fix", "patch");
    commit(root, "fix");
    // rc.0 is versioned and a fix is pending: the state Finish starts from, whether or not an rc.1 Version PR is open.
    assert.equal(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.85"]).status, 0);
    const result = script(root, "release-version.mjs", ["--final"], { GITHUB_REF_NAME: "release/0.85" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(cliVersion(root), "0.85.0");
    assert.ok(!existsSync(join(root, ".changeset/pre.json")));
    assert.ok(!existsSync(join(root, ".changeset/fix.md")) && !existsSync(join(root, ".changeset/next.md")));
    assert.match(readFileSync(join(root, "cli/nodejs/package.json"), "utf8"), /"version": "0\.85\.0"/);
  });

  it("Publish final release cut from main versions the final from the pending changesets and never enters candidates while its PR is open", async () => {
    const { prereleaseAction } = await import(pathToFileURL(join(REPO, "scripts/release-version.mjs")).href);
    const root = workspace("0.84.2");
    put(root, "package.json", '{"name":"root","private":true,"version":"1.0.0","scripts":{"version-packages":"changeset version"}}');
    changeset(root, "next", "minor");
    commit(root, "feat");
    git(root, "branch", "release/0.85");
    // Publish rebuilding the open final Version PR stays final; once it is closed, the branch enters candidates.
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", openPr: true, headLacksPre: () => true }), "none");
    assert.equal(prereleaseAction({ cwd: root, branch: "release/0.85", openPr: false }), "enter");

    const result = script(root, "release-version.mjs", ["--final", "--branch", "release/0.85"], { GITHUB_REF_NAME: "main" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(cliVersion(root), "0.85.0");
    assert.ok(!existsSync(join(root, ".changeset/pre.json")));
    assert.ok(!existsSync(join(root, ".changeset/next.md")));
  });

  it("a record copies the tag's versions, changelogs and ledger entries for what main holds, deletes what the tag released, and leaves floors alone", () => {
    const manifest = (name, version, floor) =>
      `kind: Telo.Library\nmetadata:\n  name: ${name}\n  version: ${version}\nrequires:\n  telo: "${floor}"\n`;
    const ledger = (entries) =>
      `modules:\n${entries.map(([key, version]) => `  ${key}:\n    version: ${version}\n    layers:\n      manifest: sha256-${version.replaceAll(".", "")}\n`).join("")}`;
    const root = workspace("0.84.2");
    put(root, "telo-workspace.yaml", "release:\n  modules:\n    - modules/*\n");
    put(root, "modules/a/telo.yaml", manifest("A", "1.0.0", ">=unreleased"));
    put(root, ".changes/ledger.yaml", ledger([["modules/a", "1.0.0"]]));
    changeset(root, "next", "minor");
    put(root, ".changes/pending/one.yaml", "x\n");
    commit(root, "feat");

    git(root, "switch", "-q", "-c", "release/0.85");
    rmSync(join(root, ".changeset/next.md"));
    rmSync(join(root, ".changes/pending/one.yaml"));
    put(root, "cli/nodejs/package.json", JSON.stringify({ name: "@telorun/cli", version: "0.85.0" }));
    put(root, "cli/nodejs/CHANGELOG.md", "# @telorun/cli\n\n## 0.85.0\n");
    put(root, "modules/a/telo.yaml", manifest("A", "1.1.0", ">=0.85.0"));
    put(root, "modules/a/CHANGELOG.md", "## 1.1.0\n");
    put(root, "modules/gone/telo.yaml", manifest("Gone", "2.0.0", ">=0.85.0"));
    put(root, "modules/gone/CHANGELOG.md", "## 2.0.0\n");
    put(root, ".changes/ledger.yaml", ledger([["modules/a", "1.1.0"], ["modules/gone", "2.0.0"]]));
    commit(root, "chore(release): version packages and modules");
    git(root, "tag", "modules-0.85-1");

    git(root, "switch", "-q", "main");
    put(root, ".changeset/own.md", '---\n"@telorun/cli": patch\n---\n\nmain only\n');
    put(root, ".changes/pending/one.yaml", "x\n");
    put(root, ".changes/pending/other.yaml", "main's own\n");
    commit(root, "work on main after the cut");

    const plan = recordPlanOf(root, "modules-0.85-1");
    assert.deepEqual(plan.deletions, [".changes/pending/one.yaml", ".changeset/next.md"]);
    assert.deepEqual(Object.keys(plan.writes).sort(), [
      ".changes/ledger.yaml",
      "cli/nodejs/CHANGELOG.md",
      "cli/nodejs/package.json",
      "modules/a/CHANGELOG.md",
      "modules/a/telo.yaml",
    ]);
    assert.equal(plan.writes["modules/a/telo.yaml"], manifest("A", "1.1.0", ">=unreleased"));
    assert.match(plan.writes["cli/nodejs/package.json"], /"version":"0\.85\.0"/);
    assert.equal(plan.writes[".changes/ledger.yaml"].includes("modules/gone"), false);
    assert.match(plan.writes[".changes/ledger.yaml"], /modules\/a:\n {4}version: 1\.1\.0/);
  });
});
