// The release-branch scripts — live branch, the Cut / Finish / Publish refusals,
// channel classification, the names a release gets and the record of a release on
// main — each run against a scratch git repository holding copies of the scripts
// (and links to the analyzer and CLI sources the record reads under bun).
// Run: node --test scripts/tests/

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      'Error: release/0.84 has published no candidate yet. Merge its rc Version PR ("chore(release): version packages") first, then finish.',
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

  it("opens no Module Release PR in candidates or while changesets are pending", () => {
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
    for (const head of ["changeset-release/release/0.85", "module-release/release/0.85", "release-record/release/0.85"]) {
      assert.equal(gateRefs({ cwd: root, event: "pull_request", base: "main", head }).base, "HEAD");
    }
    assert.deepEqual(gateRefs({ cwd: root, event: "pull_request", base: "release/0.85", head: "pick/x" }), {
      base: "origin/release/0.85",
      carriedBy: "",
    });
    assert.deepEqual(gateRefs({ cwd: root, event: "push", ref: "main" }), { base: "HEAD", carriedBy: "release/0.85" });
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
