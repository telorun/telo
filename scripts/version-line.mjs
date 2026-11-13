#!/usr/bin/env node
// The telo version line: the runtime units that share one version.
//
// It is the `telo` group of `telo-workspace.yaml`'s `release:` block — kernel,
// templating, analyzer, message-format, cel, sdk, cli, language-server,
// ide-support — released together by `telo release`, so every member carries
// the same version, and that version IS the surface generation a module's
// `requires.telo` range is written against. Each polyglot member is one unit
// whose npm package and crates are anchors, so `telo release apply` writes the
// version into every `package.json`, `Cargo.toml` and `Cargo.lock` entry of it.
//
// The line's version is read from what the tree records — the analyzer unit's
// `nodejs/package.json` — never planned: a build embedding a planned version
// makes the plan depend on itself. Every build of the tree is `V+unreleased`;
// only the pack step making a published payload embeds exactly `V`
// (`generate-telo-version.mjs --published`).

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The unit whose recorded version is the line's. */
const LINE_MANIFEST = join(ROOT, "analyzer", "nodejs", "package.json");

/** Every workspace package as `name -> { dir, version }`. `pnpm-workspace.yaml`'s
 *  patterns are literal segments and `*`, expanded by hand so this costs no
 *  pnpm spawn on every install. */
export function workspacePackages() {
  // A Windows checkout with `core.autocrlf` writes CRLF, which `.` does not cross.
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").replace(/\r\n/g, "\n");
  const block = /^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n)*)/m.exec(text);
  const patterns = (block?.[1] ?? "")
    .split("\n")
    .map((line) => /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line)?.[1])
    .filter(Boolean);

  const byName = new Map();
  const expand = (dir, segments) => {
    if (segments.length === 0) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
        if (name) byName.set(name, { dir, version });
      }
      return;
    }
    const [head, ...rest] = segments;
    if (head !== "*") {
      const next = join(dir, head);
      if (existsSync(next)) expand(next, rest);
      return;
    }
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const next = join(dir, entry);
      if (statSync(next).isDirectory()) expand(next, rest);
    }
  };
  for (const pattern of patterns) expand(ROOT, pattern.split("/"));
  return byName;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver precedence of two versions, prerelease included (`0.85.0-rc.1` < `0.85.0`).
 *  Build metadata is not part of a package version and is not read. */
export function compareVersions(a, b) {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const ours = left[4].split(".");
  const theirs = right[4].split(".");
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const [x, y] = [ours[i], theirs[i]];
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Number(x) - Number(y);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return ours.length - theirs.length;
}

/** `major.minor.patch` of a version, prerelease dropped. */
export function releaseTriple(version) {
  return version.split(/[-+]/)[0];
}

/** A `release/*` branch, given as a bare name or as `origin/<name>`. */
export function isReleaseBranch(name) {
  return /^(?:origin\/)?release\/.+/.test(name ?? "");
}

/** Whether a release branch (`release/<major>.<minor>`, or `origin/…`) has published
 *  its first final — `v<major>.<minor>.0` exists. Before it, the branch is fresh or
 *  in candidates; after it, it takes patches only. */
export function finalPublished({ cwd = ROOT, branch }) {
  const match = /^(?:origin\/)?release\/(\d+)\.(\d+)$/.exec(branch);
  if (!match) throw new Error(`${branch} is not a release/<major>.<minor> branch.`);
  const tags = execFileSync("git", ["tag", "--list", `v${match[1]}.${match[2]}.0`], { cwd, encoding: "utf8" });
  return tags.trim() !== "";
}

/**
 * The telo generation this tree builds, from the line's recorded version `V`:
 *
 *  - `version`: `V` itself (`0.85.0`, a candidate's `0.85.0-rc.1`);
 *  - `surface`: `V`'s triple — the manifest generation `requires: telo:` is
 *    checked against, so a candidate reports the release it previews;
 *  - `identity`: what a build of this tree reports itself as — `V+unreleased`,
 *    or exactly `V` for the published payload (`published`).
 *
 * `generate-telo-version.mjs` writes the surface and the identity;
 * `render-builtin-vocabulary.mjs` stamps the identity on the archive. Throws
 * when the version cannot be read.
 */
export function teloGeneration({ published = false } = {}) {
  const { version } = JSON.parse(readFileSync(LINE_MANIFEST, "utf8"));
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`analyzer/nodejs/package.json's version '${version}' is not a semantic version.`);
  }
  return { version, surface: releaseTriple(version), identity: published ? version : `${version}+unreleased` };
}
