#!/usr/bin/env node
// Publishes the GitHub Release for a cycle: ONE release for the whole npm stack,
// and none for a package a module owns.
//
// TWO THINGS THIS REPLACED.
//
// `changesets/action` created a release per published package — nine in the 0.82.0
// cycle for five changes, because a changeset that moves several packages is written
// verbatim into each one's changelog. It also had no filter, so module-owned
// packages surfaced here: their versions are moved by `telo release apply` from the
// MODULE ledger, and `changeset publish` then pushes any package whose version is
// not yet on npm. `@telorun/sql@0.23.0` was the `modules/sql` release wearing an npm
// package's name.
//
// A module's changelog lives in its own directory and travels in its artifact, so it
// gets no GitHub Release. That holds whether or not the module also ships an npm
// package: `sql`, `codec`, `kv-store`, `type` and `http-dispatch` ARE installed from
// npm (they are the TypeScript contracts a third-party implementation compiles
// against), and their version is still the module's, moved by the module ledger and
// changelogged with the module. What decides is who owns the version, not how the
// bytes reach a consumer.
//
// GROUPED BY CHANGE, NOT BY PACKAGE. A changeset already names every package it
// moves, so grouping by it removes the duplication AND says something no per-package
// release can: that one change moved three packages. `Updated dependencies` entries
// are dropped — they are an artifact of per-package changelogs, and the versions
// they report are in the table at the top.
//
// TAGGED `v<cli version>`. The CLI is what users identify the stack by, and it moves
// in nearly every cycle: seven of the nine releasing packages are on its dependency
// chain, and `@telorun/debug-ui` reaches it through the baked-pin gate in
// `check-changeset-status.mjs`. Only `runner-core` and `k8s-runner` can publish
// without it — those cycles fall back to a release per package, because there is no
// CLI version to name and a tag invented for them would either collide with an
// existing one or name a version that did not move.
//
// THE RELEASE'S EXISTENCE IS NOT A JOB'S EXIT CODE. It used to be gated on the
// changesets step reporting `published: true`, so a transient failure here was
// permanent: re-running the job re-runs `changeset publish`, which finds everything
// already on npm, reports `published: false`, and skips the release forever. This is
// the failure CLAUDE.md already records one job down ("A kernel image's existence is
// a function of what is on npm, not of a job's exit code"). So the step always runs,
// and the work is derived: the package set comes from the version bumps in this
// commit when the action did not report one, and a release that already exists is a
// no-op. Re-running the job on the same commit therefore heals it, and
// `workflow_dispatch` covers a run at a chosen ref.
//
// Usage (CI, after `changeset publish`):
//   PUBLISHED_PACKAGES='[{"name":"@telorun/cli","version":"0.82.0"}]' \
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo GITHUB_SHA=… node scripts/github-releases.mjs
//
// `--dry-run` renders the release to stdout and calls nothing.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadWorkspace } from "./module-ownership.mjs";

const dryRun = process.argv.includes("--dry-run");

const CLI = "@telorun/cli";
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const commit = process.env.GITHUB_SHA;

// Actions writes '' — not "unset" — for an output that was never set, so `??` passes
// the empty string straight into JSON.parse and it throws three lines above the
// graceful exit.
const publishedRaw = process.env.PUBLISHED_PACKAGES || "[]";
let published;
try {
  published = JSON.parse(publishedRaw);
} catch (error) {
  console.error(`::error::PUBLISHED_PACKAGES is not valid JSON: ${error.message}`);
  process.exit(1);
}
if (!Array.isArray(published)) published = [];

if (!dryRun && (!repository || !token)) {
  console.error("::error::GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
  process.exit(1);
}

const workspace = loadWorkspace();

/**
 * The packages whose versions moved in this commit — the recovery source when the
 * changesets action did not report a set (a re-run, or a manual dispatch). A Version
 * PR merge is exactly a commit that rewrites `version` in each released package's
 * manifest, which is the same signal `publish-modules.mjs` uses for modules.
 */
function versionBumpsInHeadCommit() {
  let diff;
  try {
    diff = execSync("git diff --unified=0 HEAD^ HEAD -- '**/package.json' package.json", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return []; // No parent commit, or no git — nothing to recover from.
  }
  const bumped = [];
  let file = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const added = /^\+\s*"version":\s*"([^"]+)"/.exec(line);
    if (!added || !file) continue;
    const dir = join(ROOT, file.replace(/\/package\.json$/, ""));
    const pkg = workspace.packages.find((p) => p.dir === dir);
    if (pkg) bumped.push({ name: pkg.name, version: added[1] });
  }
  return bumped;
}

/** The CHANGELOG section for exactly this version: everything under the
 *  `## <version>` heading, up to the next heading at the same level. */
function changelogSection(dir, version) {
  const file = join(dir ?? "", "CHANGELOG.md");
  if (!dir || !existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const start = text.search(new RegExp(`^## ${version.replace(/\./g, "\\.")}\\s*$`, "m"));
  if (start === -1) return "";
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const LEVELS = ["major", "minor", "patch"];
const LEVEL_RANK = { patch: 0, minor: 1, major: 2 };

/**
 * The changeset entries in one package's section, as `{ id, level, title, body }`.
 *
 * An entry opens with `- ` at column zero and continues through two-space-indented
 * lines. The changesets changelog generator prefixes the commit id only when it can
 * resolve one from git, so `- <title>` with no id is a valid entry and must not be
 * treated as noise — matching on the id and discarding the rest silently emptied the
 * whole release body in exactly the case (an unresolvable commit) where nothing else
 * would report it.
 *
 * Two shapes are dropped, both dependency bookkeeping rather than a change:
 * `- Updated dependencies …` and its indented list, and a bare `- <pkg>@<version>`,
 * which is what a section carries when a dependency moved with no changeset of its
 * own. Dropping only the first renders the second as a change titled
 * `@telorun/templating@0.16.0`.
 */
const DEPENDENCY_LINE = /^[@\w][^\s]*@\d[^\s]*$/;
function entriesIn(section) {
  const entries = [];
  let level = null;
  let current = null;
  const flush = () => {
    if (current) entries.push({ ...current, body: current.lines.join("\n").trim() });
    current = null;
  };
  for (const line of section.split("\n")) {
    const heading = /^### (Major|Minor|Patch) Changes\s*$/.exec(line);
    if (heading) {
      flush();
      level = heading[1].toLowerCase();
      continue;
    }
    if (/^- Updated dependencies/.test(line)) {
      flush();
      current = null;
      continue;
    }
    const opener = /^- (?:([0-9a-f]{7,}): )?(.*)$/.exec(line);
    if (opener) {
      flush();
      const title = opener[2].trim();
      current =
        !opener[1] && DEPENDENCY_LINE.test(title)
          ? null
          : { id: opener[1] ?? "", level, title, lines: [] };
      continue;
    }
    if (current) current.lines.push(line.replace(/^ {2}/, ""));
  }
  flush();
  // An entry list that opened before any `### … Changes` heading is a section shape
  // the parser did not expect. It is reported rather than dropped — see renderBody.
  return entries.filter((entry) => entry.title !== "");
}

/**
 * One entry per CHANGE, carrying every package it moved.
 *
 * Keyed on id AND title, because the id is the COMMIT that added the changeset, not
 * the changeset: one commit carrying two changeset files writes both entries under
 * the same id, and keying on the id alone merged two changes into one — keeping the
 * first body and attributing both packages to it. The title is what the changeset
 * file itself contributed, and a changeset written into several packages is written
 * identically into each, so the pair groups across packages exactly as intended.
 */
function collectChanges(releases, dirs) {
  const changes = new Map();
  for (const pkg of releases) {
    for (const entry of entriesIn(changelogSection(dirs.dirOf(pkg.name), pkg.version))) {
      const key = `${entry.id}\n${entry.title}`;
      const change = changes.get(key) ?? {
        title: entry.title,
        body: entry.body,
        level: entry.level,
        packages: [],
      };
      // A change can be minor for one package and patch for another; it is filed
      // under the strongest bump it caused.
      if ((LEVEL_RANK[entry.level] ?? -1) > (LEVEL_RANK[change.level] ?? -1)) {
        change.level = entry.level;
      }
      if (!change.packages.includes(pkg.name)) change.packages.push(pkg.name);
      changes.set(key, change);
    }
  }
  return [...changes.values()];
}

function renderBody(releases, changes, dirs, tag) {
  const short = (name) => name.replace("@telorun/", "");
  const out = ["### Packages", "", "| Package | Version |", "| --- | --- |"];
  for (const pkg of releases) out.push(`| \`${pkg.name}\` | ${pkg.version} |`);

  const render = (heading, group) => {
    if (group.length === 0) return;
    out.push("", `### ${heading}`);
    for (const change of group) {
      out.push(
        "",
        `**${change.title}** — ${change.packages.map((n) => `\`${short(n)}\``).join(", ")}`,
      );
      if (change.body) out.push("", change.body);
    }
  };

  for (const level of LEVELS) {
    render(level[0].toUpperCase() + level.slice(1), changes.filter((c) => c.level === level));
  }
  // A change whose bump level the parser could not read is still SHOWN. Filing it
  // under a level would misreport it and dropping it left a release that counted
  // changes it never rendered — a package table with no changes and no explanation.
  render(
    "Changes",
    changes.filter((c) => !LEVELS.includes(c.level)),
  );

  if (changes.length === 0) {
    out.push("", "Released to pick up changes in dependencies; see the changelogs below.");
  }

  const links = releases
    .map((pkg) => {
      const dir = (dirs.dirOf(pkg.name) ?? "").replace(ROOT + "/", "");
      return `[${short(pkg.name)}](https://github.com/${repository ?? "telorun/telo"}/blob/${tag}/${dir}/CHANGELOG.md)`;
    })
    .join(" · ");
  out.push("", "---", "", `Changelogs: ${links}`);
  return out.join("\n");
}

async function github(path, init = {}) {
  return fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

/** Whether a release already exists for `tag` — the probe that makes a re-run a
 *  no-op rather than a duplicate or an error. */
async function releaseExists(tag) {
  if (dryRun) return false;
  const response = await github(`/releases/tags/${encodeURIComponent(tag)}`);
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`Checking release ${tag} failed: ${response.status} ${await response.text()}`);
}

async function createRelease({ tag, name, body }) {
  const response = await github("/releases", {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      name,
      body: body || undefined,
      ...(commit ? { target_commitish: commit } : {}),
    }),
  });
  if (response.ok) return;
  // A release created between the probe and this call is the shape a concurrent
  // re-run takes; anything else is a real failure and must not be swallowed.
  const detail = await response.text();
  if (response.status === 422 && detail.includes("already_exists")) {
    console.log(`  = ${tag} (release already exists)`);
    return;
  }
  throw new Error(`Creating release ${tag} failed: ${response.status} ${detail}`);
}

let candidates = published;
if (candidates.length === 0) {
  candidates = versionBumpsInHeadCommit();
  if (candidates.length > 0) {
    console.log(
      `github-releases: no published set was reported; recovered ${candidates.length} ` +
        `version bump${candidates.length === 1 ? "" : "s"} from this commit.`,
    );
  }
}
if (candidates.length === 0) {
  console.log("github-releases: nothing was published; no releases to create.");
  process.exit(0);
}

const releases = [];
const modules = [];
for (const pkg of candidates) {
  if (workspace.isModuleOwned(pkg.name)) modules.push(pkg);
  // `releasing` is published AND non-module, which also drops the PRIVATE packages
  // the recovery path turns up: a Version PR bumps `@telorun/studio` and
  // `telo-vscode` too, and neither reaches npm or belongs in this table. The
  // action's own published set never contains them, so this only bites on recovery.
  else if (workspace.releasing.has(pkg.name)) releases.push(pkg);
}

if (modules.length > 0) {
  console.log(
    `github-releases: ${modules.length} module-owned package${modules.length === 1 ? "" : "s"} ` +
      `published to npm; no GitHub Release for these (the module's changelog is its own):`,
  );
  for (const pkg of modules) console.log(`  - ${pkg.name}@${pkg.version}`);
}
if (releases.length === 0) {
  console.log("github-releases: nothing outside the module ledger was published.");
  process.exit(0);
}

// The CLI is the stack's identity. Sort it to the top of the table, then the rest
// alphabetically — the table is read, not parsed.
releases.sort((a, b) => (a.name === CLI ? -1 : b.name === CLI ? 1 : a.name.localeCompare(b.name)));

const cli = releases.find((pkg) => pkg.name === CLI);

if (!cli) {
  console.log(
    `github-releases: ${CLI} did not move, so there is no version to name the cycle after; ` +
      `releasing ${releases.length} package${releases.length === 1 ? "" : "s"} individually` +
      `${dryRun ? " (dry run)" : ""}:`,
  );
  for (const pkg of releases) {
    const tag = `${pkg.name}@${pkg.version}`;
    if (await releaseExists(tag)) {
      console.log(`  = ${tag} (release already exists)`);
      continue;
    }
    const section = changelogSection(workspace.dirOf(pkg.name), pkg.version);
    console.log(`  + ${tag}`);
    if (!dryRun) {
      await createRelease({ tag, name: tag, body: section.replace(/^## .*\n/, "").trim() });
    }
  }
  process.exit(0);
}

const tag = `v${cli.version}`;
if (await releaseExists(tag)) {
  console.log(`github-releases: ${tag} already exists; nothing to do.`);
  process.exit(0);
}

const changes = collectChanges(releases, workspace);
const body = renderBody(releases, changes, workspace, tag);

console.log(
  `github-releases: one release — ${tag} — covering ${releases.length} packages ` +
    `and ${changes.length} change${changes.length === 1 ? "" : "s"}${dryRun ? " (dry run)" : ""}.`,
);
if (dryRun) {
  console.log(`\n${"=".repeat(72)}\nTelo ${tag}\n${"=".repeat(72)}\n${body}`);
} else {
  await createRelease({ tag, name: `Telo ${tag}`, body });
}
