// Shared pointers move only forward; the site is composed from release assets.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ensureRelease } from "../github-releases.mjs";
import { attachAssets } from "../release-assets.mjs";
import { imageLatestMoves, imageVersionOf, pointerMoves } from "../release-pointers.mjs";
import { moveStable, stableMoves } from "../release-stable.mjs";
import { promotion } from "../release-promote.mjs";
import { composePlan, siteBuild } from "../release-site.mjs";

describe("pointer moves", () => {
  const tags = ["v0.84.1", "v0.84.2", "v0.85.0-rc.1", "v0.85.0"];

  it("moves every pointer to the newest final", () => {
    assert.deepEqual(pointerMoves({ version: "0.85.0", channel: "final", tags }), { latest: true, major: true, minor: true });
  });

  it("moves nothing for a candidate", () => {
    assert.deepEqual(pointerMoves({ version: "0.86.0-rc.1", channel: "candidate", tags }), { latest: false, major: false, minor: false });
  });

  it("re-running an older publish moves latest and the major, not the line it was behind", () => {
    assert.deepEqual(pointerMoves({ version: "0.84.2", channel: "patch", tags }), { latest: false, major: false, minor: true });
  });

  it("moves the minor pointer only within its line", () => {
    const withPatch = [...tags, "v0.85.1"];
    assert.deepEqual(pointerMoves({ version: "0.85.0", channel: "final", tags: withPatch }), { latest: false, major: false, minor: false });
    assert.deepEqual(pointerMoves({ version: "1.0.0", channel: "final", tags: withPatch }), { latest: true, major: true, minor: true });
  });
});

describe("app image latest", () => {
  it("reads an image's own version from its package.json or telo.yaml", () => {
    assert.equal(imageVersionOf("apps/x/package.json", '{"version":"1.4.0"}'), "1.4.0");
    assert.equal(imageVersionOf("apps/x/telo.yaml", 'kind: Telo.Application\nmetadata:\n  name: X\n  version: "0.3.1"\n'), "0.3.1");
    assert.equal(imageVersionOf("apps/x/telo.yaml", "kind: Telo.Application\n"), undefined);
  });

  it("moves latest unless a release tag holds a higher version of the image", () => {
    assert.equal(imageLatestMoves({ version: "1.4.0", tagVersions: ["1.3.0", "1.4.0"] }), true);
    assert.equal(imageLatestMoves({ version: "1.3.0", tagVersions: ["1.3.0", "1.4.0"] }), false);
    assert.equal(imageLatestMoves({ version: "1.0.0", tagVersions: [] }), true);
  });
});

describe("GitHub Release promotion", () => {
  it("publishes a candidate as a pre-release that is not latest", () => {
    assert.deepEqual(promotion({ tag: "v0.85.0-rc.1", latestTag: "v0.84.2" }), { draft: false, prerelease: true, make_latest: "false" });
  });

  it("makes a final latest, unless a higher release already is", () => {
    assert.equal(promotion({ tag: "v0.85.0", latestTag: "v0.84.2" }).make_latest, "true");
    assert.equal(promotion({ tag: "v0.84.2", latestTag: "v0.85.0" }).make_latest, "false");
  });
});

describe("GitHub Release creation", () => {
  const fakeGithub = (pages) => {
    const calls = [];
    const sent = [];
    const github = async (path, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      if (init.body) sent.push(JSON.parse(init.body));
      const page = /[?&]page=(\d+)/.exec(path)?.[1];
      const body = page ? (pages[Number(page) - 1] ?? []) : path === "/releases/latest" ? { tag_name: "v0.84.2" } : {};
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    return { github, calls, sent };
  };
  const release = { tag: "v0.85.0", name: "Telo v0.85.0", body: "notes", line: true, channel: "final", version: "0.85.0" };

  it("fills an empty draft on a later page instead of creating a second one, and leaves one with a body", async () => {
    const other = Array.from({ length: 100 }, (_, i) => ({ id: i, tag_name: `v0.1.${i}`, body: "x" }));
    const empty = fakeGithub([other, [{ id: 7, tag_name: "v0.85.0", draft: true, body: "" }]]);
    await ensureRelease({ ...release, github: empty.github });
    assert.deepEqual(empty.calls, ["GET /releases?per_page=100&page=1", "GET /releases?per_page=100&page=2", "PATCH /releases/7"]);

    const filled = fakeGithub([[{ id: 7, tag_name: "v0.85.0", draft: true, body: "notes" }]]);
    await ensureRelease({ ...release, github: filled.github });
    assert.deepEqual(filled.calls, ["GET /releases?per_page=100&page=1"]);
  });

  it("creates the release as a draft when no release holds the tag", async () => {
    const { github, calls, sent } = fakeGithub([[{ id: 1, tag_name: "v0.84.2", body: "x" }]]);
    await ensureRelease({ ...release, github });
    assert.deepEqual([sent[0].tag_name, sent[0].draft, sent[0].make_latest], ["v0.85.0", true, "true"]);
    assert.deepEqual(calls, [
      "GET /releases?per_page=100&page=1",
      "GET /releases?per_page=100&page=2",
      "GET /releases/latest",
      "POST /releases",
    ]);
  });
});

describe("site build", () => {
  it("builds a candidate for /next/ with the release it previews", () => {
    assert.deepEqual(siteBuild({ tag: "v0.85.0-rc.1" }), {
      channel: "candidate",
      version: "0.85.0-rc.1",
      asset: "site-next.tar.gz",
      baseUrl: "/next/",
      preview: "0.85.0",
    });
  });

  it("builds a final or patch for /", () => {
    assert.equal(siteBuild({ tag: "v0.85.1" }).asset, "site-root.tar.gz");
    assert.equal(siteBuild({ tag: "v0.85.1" }).baseUrl, "/");
  });

  it("refuses a name that is not a release tag", () => {
    assert.throws(() => siteBuild({ tag: "0.85.0" }), /not a release tag/);
    assert.throws(() => siteBuild({ tag: "vscode-v0.9.0" }), /not a release tag/);
  });
});

describe("site composition", () => {
  const release = (tag, assets = ["site-root.tar.gz"], extra = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: assets.map((name) => ({ name })),
    ...extra,
  });
  const releases = [
    release("v0.85.0-rc.1", ["site-next.tar.gz"], { prerelease: true }),
    release("v0.84.2"),
    release("v0.84.1"),
    release("v0.85.0", ["site-root.tar.gz"], { draft: true }),
  ];

  it("serves the newest published final at / and an open candidate at /next/", () => {
    assert.deepEqual(composePlan({ channel: "candidate", version: "0.85.0-rc.2", releases }), { root: { tag: "v0.84.2" }, next: true });
  });

  it("serves no /next/ for a candidate of a release that already shipped", () => {
    const shipped = [release("v0.85.0"), ...releases];
    assert.deepEqual(composePlan({ channel: "candidate", version: "0.85.0-rc.1", releases: shipped }), { root: { tag: "v0.85.0" }, next: false });
  });

  it("serves this run's root for a final, and drops /next/", () => {
    assert.deepEqual(composePlan({ channel: "final", version: "0.85.0", releases }), { root: { own: true }, next: false });
  });

  it("serves the newest final when an older release is re-published", () => {
    const shipped = [release("v0.85.0"), ...releases];
    assert.deepEqual(composePlan({ channel: "patch", version: "0.84.2", releases: shipped }), { root: { tag: "v0.85.0" }, next: false });
  });

  it("refuses to compose when the newest final has no site root", () => {
    assert.throws(() => composePlan({ channel: "candidate", version: "0.85.0-rc.1", releases: [release("v0.84.2", [])] }), /no site-root\.tar\.gz/);
  });

  it("refuses a candidate with no published final at all", () => {
    assert.throws(() => composePlan({ channel: "candidate", version: "0.85.0-rc.1", releases: [] }), /No published final/);
  });
});

describe("release assets", () => {
  process.env.GITHUB_REPOSITORY = "o/r";
  const fakeApi = (releases) => {
    const calls = [];
    const api = async (method, url) => {
      calls.push(`${method} ${url.replace(/^https:\/\/uploads\.github\.com\/repos\/[^/]+\/[^/]+/, "")}`);
      const body = method === "GET" ? (url.endsWith("page=1") ? releases : []) : {};
      return { status: 201, ok: true, json: async () => body, text: async () => "" };
    };
    return { api, calls };
  };

  it("attaches to a draft release and replaces an asset of the same name", async () => {
    const { api, calls } = fakeApi([{ id: 7, tag_name: "v0.85.0", draft: true, assets: [{ id: 3, name: "site-root.tar.gz" }] }]);
    await attachAssets({ tag: "v0.85.0", files: [{ name: "site-root.tar.gz", bytes: Buffer.from("x") }], api });
    assert.deepEqual(calls, [
      "GET /releases?per_page=100&page=1",
      "DELETE /releases/assets/3",
      "POST /releases/7/assets?name=site-root.tar.gz",
    ]);
  });

  it("refuses a tag with no release rather than creating one", async () => {
    const { api } = fakeApi([{ id: 7, tag_name: "v0.84.2", assets: [] }]);
    await assert.rejects(attachAssets({ tag: "v0.85.0", files: [], api }), /No release for v0\.85\.0/);
  });
});

describe("standalone package versions", () => {
  it("spells a candidate so it sorts before its final", async () => {
    const { nativeVersion } = await import("../../.github/scripts/package-standalone.mjs");
    assert.equal(nativeVersion("deb", "0.85.0-rc.1"), "0.85.0~rc.1");
    assert.equal(nativeVersion("rpm", "0.85.0-rc.1"), "0.85.0~rc.1");
    assert.equal(nativeVersion("msi", "0.85.0-rc.1"), "0.85.0");
    assert.equal(nativeVersion("deb", "0.85.0"), "0.85.0");
  });
});

describe("stable branch", () => {
  const tags = ["v0.84.2", "v0.85.0-rc.1", "v0.85.0"];

  it("follows the newest final or patch", () => {
    assert.equal(stableMoves({ tag: "v0.85.0", tags }), true);
    assert.equal(stableMoves({ tag: "v0.85.1", tags: [...tags, "v0.85.1"] }), true);
  });

  it("never moves backwards, for a candidate, or for a modules or packages release", () => {
    assert.equal(stableMoves({ tag: "v0.84.2", tags }), false);
    assert.equal(stableMoves({ tag: "v0.86.0-rc.1", tags }), false);
    assert.equal(stableMoves({ tag: "modules-0.85-1", tags }), false);
    assert.equal(stableMoves({ tag: "packages-0.85-1", tags }), false);
  });
});

describe("stable branch push", () => {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  it("force-pushes the commit for the newest final and leaves it for an older one", () => {
    const dir = mkdtempSync(join(tmpdir(), "stable-"));
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    git(dir, "init", "--bare", remote);
    git(dir, "init", work);
    git(work, "remote", "add", "origin", remote);
    const commit = (name) => {
      writeFileSync(join(work, "f"), name);
      git(work, "add", "f");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", name);
      return git(work, "rev-parse", "HEAD");
    };
    const env = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const a = commit("a");
      const b = commit("b");
      const tags = ["v0.1.0", "v0.2.0"];
      assert.equal(moveStable({ tag: "v0.2.0", sha: b, tags, cwd: work }), true);
      assert.equal(git(remote, "rev-parse", "refs/heads/stable"), b);
      assert.equal(moveStable({ tag: "v0.1.0", sha: a, tags, cwd: work }), false);
      assert.equal(git(remote, "rev-parse", "refs/heads/stable"), b);
      assert.equal(moveStable({ tag: "v0.2.0", sha: b, tags, cwd: work }), true);
      assert.equal(git(remote, "rev-parse", "refs/heads/stable"), b);
    } finally {
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    }
  });
});
