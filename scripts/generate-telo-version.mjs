#!/usr/bin/env node
// Generates `analyzer/nodejs/src/telo-version.ts` — the manifest SURFACE
// GENERATION this build of the analyzer implements — and
// `packages/language-server/src/engine-version.ts` — the IDENTITY the engine
// built from this tree reports in its handshake.
//
// The telo runtime packages share ONE version line: the changesets `fixed` group
// that contains `@telorun/analyzer` (sdk, templating, analyzer, kernel, cli,
// ide-support, language-server). A package belongs to it exactly when its content
// is bound to one telo generation, so every member's version IS the generation it
// implements, and a module's `requires.telo` range is written against that one
// scale. Reading the group from `.changeset/config.json` rather than naming a
// package keeps this constant, the number `changeset version` writes and the
// number `requires:` verification installs (`npx @telorun/cli@<edge>`) one fact.
//
// The generation is the group's version as changesets will write it next: the
// HIGHEST member version, with the strongest pending bump any changeset declares
// for ANY member applied — which is how changesets computes a fixed group's next
// version. Pending changesets count because `package.json` holds the LAST
// PUBLISHED version while this constant claims the generation this build
// IMPLEMENTS. Between releases those differ, and the difference lands on exactly
// the commit where it hurts: a module adopting new syntax declares the floor of
// the release that will carry it, and the workspace would otherwise reject its own
// module with `MODULE_REQUIRES_NEWER_RUNTIME`. The number does not jump at release
// time: once `changeset version` writes it and consumes the changesets, the
// no-pending path reads the same number.
//
// The bumps are read from `.changeset/*.md` directly rather than by spawning
// `changeset status`: this runs on every workspace install, and loading the whole
// changesets graph to answer one question is not worth the install time. What that
// trades away is a bump INDUCED by a dependency (`updateInternalDependencies:
// "patch"`), which is by definition a patch and therefore never the release that
// introduces syntax.
//
// Refuses to run when `@telorun/analyzer` is in no `fixed` group: without the line
// there is no single number a module's range could be compared against, and
// guessing one (the CLI's, the analyzer's own) would silently gate every module on
// a scale nothing else uses.
//
// Generating it is what lets a browser-safe analyzer answer "what version am I?"
// with no CLI to ask and no filesystem to read — the same problem
// `copy-value-type-entries.mjs` and `copy-migration-entries.mjs` solve by putting
// data into the source tree before it is bundled.
//
// The engine identity is the surface generation `X` when no line changeset is
// pending — the build IS the release `X` — and `X+unreleased` while one is: that
// build implements `X` but is not the `X` that will be published, and an editor
// tells engines apart by the whole identity, so a development or main-branch
// build never passes for a published engine (`@telorun/editor-protocol` §
// Handshake). Build metadata leaves semver precedence alone, so the build still
// satisfies a module forward-declaring `>=X`.
//
// Runs from the root `prepare` (pnpm, on workspace install, so a fresh clone
// builds) and from the `prepare` of the analyzer and the language-server (npm,
// before pack/publish, so a published tarball carries it).
//
// Both destinations are gitignored AND must stay untracked — `.gitignore` has no
// effect on a tracked file, so committing it once would silently turn it into a
// second place the version lives, stale after every bump.
//
// Usage: node scripts/generate-telo-version.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, versionLineMembers, workspacePackages } from "./version-line.mjs";

const DEST = join(ROOT, "analyzer", "nodejs", "src", "telo-version.ts");
const ENGINE_DEST = join(ROOT, "packages", "language-server", "src", "engine-version.ts");

function fail(message) {
  console.error(`generate-telo-version: ${message}`);
  process.exit(1);
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;

function compareVersions(a, b) {
  const [, am, an, ap] = VERSION.exec(a).map(Number);
  const [, bm, bn, bp] = VERSION.exec(b).map(Number);
  return am - bm || an - bn || ap - bp;
}

/** The strongest bump any pending changeset declares for a member of the line.
 *  The front matter is a YAML mapping of `"name": bump`, one per line — the same
 *  shape `check-changeset-status.mjs` reads. */
function pendingBump(members) {
  const dir = join(ROOT, ".changeset");
  const rank = { patch: 1, minor: 2, major: 3 };
  let strongest;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const frontMatter = readFileSync(join(dir, file), "utf8").split(/^---$/m)[1];
    if (!frontMatter) continue;
    for (const line of frontMatter.split("\n")) {
      const match = /^\s*["']?(@?[^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (!match || !members.has(match[1].trim())) continue;
      const bump = match[2];
      if (strongest === undefined || rank[bump] > rank[strongest]) strongest = bump;
    }
  }
  return strongest;
}

/** `version` with `bump` applied, by plain semver — pre-1.0 is NOT special-cased,
 *  because changesets does not special-case it either: a minor on 0.78.0 is
 *  0.79.0, which is precisely how this repo ships a breaking change. */
function applyBump(base, bump) {
  const [, major, minor, patch] = VERSION.exec(base).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

let members;
try {
  members = new Set(versionLineMembers());
} catch (error) {
  fail(error.message);
}
const packages = workspacePackages();

let highest;
for (const name of members) {
  const pkg = packages.get(name);
  if (!pkg) {
    fail(`the version line names ${name}, which is not a workspace package.`);
  }
  if (typeof pkg.version !== "string" || !VERSION.test(pkg.version)) {
    fail(`${name}'s version '${pkg.version}' is not a three-part semantic version.`);
  }
  if (highest === undefined || compareVersions(pkg.version, highest) > 0) highest = pkg.version;
}

const bump = pendingBump(members);
const surface = bump ? applyBump(highest, bump) : highest;

const contents = `// GENERATED by scripts/generate-telo-version.mjs — do not edit.
//
// The manifest SURFACE GENERATION this build implements: the version of the telo
// version line (the changesets \`fixed\` group of the runtime packages), with any
// pending bump applied. Every package on the line carries it as its own version,
// and it is the scale a module's \`requires.telo\` range is written against.

/** The surface generation this analyzer implements. */
export const TELO_SURFACE_VERSION = ${JSON.stringify(surface)};
`;

const identity = bump ? `${surface}+unreleased` : surface;
const engineContents = `// GENERATED by scripts/generate-telo-version.mjs — do not edit.
//
// The identity this engine reports as \`serverInfo.version\`: the telo version it
// implements, with \`+unreleased\` while that release is still pending.

/** This engine's identity. */
export const TELO_ENGINE_VERSION = ${JSON.stringify(identity)};
`;

// Idempotent: skip a write when unchanged, so a no-op install does not churn
// mtimes and retrigger every downstream build that watches these files.
function write(dest, text) {
  if (existsSync(dest) && readFileSync(dest, "utf8") === text) return false;
  writeFileSync(dest, text);
  return true;
}

if (write(DEST, contents)) {
  console.log(
    `generate-telo-version: wrote surface generation ${surface}` +
      (bump ? ` (${highest} plus a pending ${bump} bump)` : ""),
  );
}
if (write(ENGINE_DEST, engineContents)) {
  console.log(`generate-telo-version: wrote engine identity ${identity}`);
}
