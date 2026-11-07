// The release-branch scripts — live branch, the Cut / Finish / Publish refusals,
// channel classification and the names a release gets — each run against a scratch
// git repository holding copies of the scripts. Run: node --test scripts/tests/

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
  put(root, ".gitignore", "node_modules\n");
  for (const [name, dir] of Object.entries(LINE)) put(root, `${dir}/package.json`, JSON.stringify({ name, version }));
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

function script(root, name, args, env = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", name), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", ...env },
  });
}

const refused = (result) => /^::error::(.*)$/m.exec(result.stdout)?.[1];

/** The timeline of the plan: 0.85.0 shipped, release/0.85 live, main on its way to 0.86. */
function timeline() {
  const root = workspace("0.85.0");
  branch(root, "release/0.85");
  changeset(root, "next", "minor");
  commit(root, "feat on main");
  return root;
}

describe("Cut release refusals", () => {
  it("refuses off main", () => {
    const root = timeline();
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "feat/x"]);
    assert.equal(refused(result), "Error: Cut release runs on main; feat/x is not main.");
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

  it("refuses until main contains the newest v*, modules-* and packages-* tag of the live branch", () => {
    const root = timeline();
    git(root, "switch", "-q", "release/0.85");
    put(root, "fix.txt", "x");
    commit(root, "fix");
    git(root, "tag", "v0.85.1");
    put(root, "fix.txt", "y");
    commit(root, "modules");
    git(root, "tag", "modules-0.85-1");
    git(root, "tag", "modules-0.85-2");
    put(root, "fix.txt", "z");
    commit(root, "more modules");
    git(root, "tag", "modules-0.85-3");
    put(root, "fix.txt", "w");
    commit(root, "packages");
    git(root, "tag", "packages-0.85-2");
    git(root, "switch", "-q", "main");

    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      'Error: main does not contain v0.85.1. Merge "chore(release): merge v0.85.1 into main" first.',
    );
    git(root, "merge", "-q", "--no-ff", "-m", "merge back", "v0.85.1");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      'Error: main does not contain modules-0.85-3. Merge "chore(release): merge modules-0.85-3 into main" first.',
    );
    git(root, "merge", "-q", "--no-ff", "-m", "merge back", "modules-0.85-3");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["cut-check", "--ref", "main"])),
      'Error: main does not contain packages-0.85-2. Merge "chore(release): merge packages-0.85-2 into main" first.',
    );
    git(root, "merge", "-q", "--no-ff", "-m", "merge back", "packages-0.85-2");
    const result = script(root, "release-branch.mjs", ["cut-check", "--ref", "main"]);
    assert.equal(result.status, 0, result.stdout);
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

  it("cut-prepare deletes the pending changesets and fragments and reports the branch point", () => {
    const root = workspace("0.84.2");
    changeset(root, "a", "minor");
    changeset(root, "b", "patch");
    put(root, ".changeset/README.md", "readme");
    put(root, ".changes/pending/one.yaml", "x");
    put(root, ".changes/pending/.gitkeep", "");
    commit(root, "pending");
    const parent = git(root, "rev-parse", "HEAD");
    const result = script(root, "release-branch.mjs", ["cut-prepare"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^changesets=2$/m);
    assert.match(result.stdout, /^fragments=1$/m);
    assert.match(result.stdout, new RegExp(`^parent=${parent}$`, "m"));
    assert.ok(existsSync(join(root, ".changeset/README.md")) && existsSync(join(root, ".changes/pending/.gitkeep")));
    assert.ok(!existsSync(join(root, ".changeset/a.md")) && !existsSync(join(root, ".changes/pending/one.yaml")));
  });

  it("reads the branch point from a cut PR's first commit", async () => {
    const { cutBranchPoint } = await import(pathToFileURL(join(REPO, "scripts/release-branch.mjs")).href);
    const commits = [{ commit: { message: "chore(release): cut 0.85" }, parents: [{ sha: "9b02f3d" }] }];
    assert.deepEqual(cutBranchPoint({ head: "release-cut/0.85", commits }), { branch: "release/0.85", sha: "9b02f3d" });
    assert.throws(() => cutBranchPoint({ head: "release-cut/0.86", commits }), /not the cut commit/);
    assert.throws(() => cutBranchPoint({ head: "feat/x", commits }), /not a release-cut/);
  });
});

describe("Finish release refusals", () => {
  it("refuses main, a branch with no pre.json, and one that already exited", () => {
    const root = workspace("0.85.0");
    branch(root, "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "main"])),
      "Error: Finish release runs on a release/* branch in candidates; main is not one.",
    );
    git(root, "switch", "-q", "release/0.84");
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      "Error: release/0.84 holds no .changeset/pre.json, so it is not in candidates.",
    );
    put(root, ".changeset/pre.json", '{"mode":"exit","tag":"rc","initialVersions":{},"changesets":[]}');
    assert.equal(
      refused(script(root, "release-branch.mjs", ["finish-check", "--ref", "release/0.84"])),
      "Error: release/0.84 has already exited candidates; merge its Version PR to publish 0.84.0.",
    );
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
      channel: "candidate", version: "0.85.0-rc.1", tag: "v0.85.0-rc.1", "release-tag": "v0.85.0-rc.1", candidates: "true", "merge-ref": "",
    });
    release(root, "0.85.0");
    assert.deepEqual(classify(root), {
      channel: "final", version: "0.85.0", tag: "v0.85.0", "release-tag": "v0.85.0", candidates: "false", "merge-ref": "v0.85.0",
    });
    release(root, "0.85.1");
    assert.equal(classify(root).channel, "patch");
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
    assert.equal(others["merge-ref"], "packages-0.85-1");

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

  it("names the merge-back PR after the tag and skips a tag main already holds", async () => {
    const { mergeBackPlan, containedInMain } = await import(pathToFileURL(join(REPO, "scripts/release-merge-back.mjs")).href);
    assert.equal(mergeBackPlan("v0.85.1").title, "chore(release): merge v0.85.1 into main");
    assert.equal(mergeBackPlan("modules-0.85-3").branch, "merge-back/modules-0.85-3");
    assert.equal(mergeBackPlan("packages-0.85-2").title, "chore(release): merge packages-0.85-2 into main");
    assert.match(mergeBackPlan("v0.85.1").body, /merge commit/);
    const root = workspace("0.85.0");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "tag", "v0.85.0");
    put(root, "x.txt", "x");
    git(root, "switch", "-q", "-c", "release/0.85");
    commit(root, "patch");
    git(root, "tag", "v0.85.1");
    assert.equal(containedInMain({ cwd: root, ref: "v0.85.0" }), true);
    assert.equal(containedInMain({ cwd: root, ref: "v0.85.1" }), false);
  });
});
