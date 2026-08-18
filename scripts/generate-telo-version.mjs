#!/usr/bin/env node
// Generates `analyzer/nodejs/src/telo-version.ts` — the manifest SURFACE
// GENERATION this build of the analyzer implements.
//
// This is deliberately NOT the analyzer's own npm version. The two are different
// facts: `@telorun/analyzer@0.61.0` is the package's release identity, while the
// surface generation it implements is the linked kernel/cli/sdk number a module's
// `requires.telo` range is written against. Comparing a module's declared range
// against the package version would compare two different scales.
//
// Generating it is what lets a browser-safe analyzer answer "what version am I?"
// with no CLI to ask and no filesystem to read — the same problem
// `copy-value-type-entries.mjs` and `copy-migration-entries.mjs` already solve by
// putting data into the source tree before it is bundled. It also generalizes to
// the polyglot kernels: a Rust or Go kernel reports the generation it implements
// the same way, independent of its own crate or module version, which is what
// keeps `requires.telo` ONE scale rather than a range per kernel.
//
// The source of truth is `cli/nodejs/package.json`. It is read from the CLI
// rather than the kernel deliberately: `@telorun/cli` is the package the
// verification path actually installs (`npx @telorun/cli@<edge> check`) and the
// package the "an upper bound must already exist" check queries, so naming one
// package throughout means the constant, the existence check and the thing that
// runs cannot disagree about what a surface generation IS. `cli`, `kernel` and
// `sdk` are `linked` in changesets and versioned in one pass, so the number is
// the same either way — but only one of them is the number this mechanism can
// verify against a registry.
//
// PENDING CHANGESETS COUNT, because `package.json` holds the LAST PUBLISHED
// version while this constant claims to be the generation this build IMPLEMENTS.
// Between releases those differ, and the difference lands on exactly the commit
// where it hurts: a module adopting new syntax declares the floor of the release
// that will carry it, and the workspace then rejects its own module with
// `MODULE_REQUIRES_NEWER_RUNTIME` — a version skew against itself. So a pending
// bump for the linked group is applied here. The number does not jump at release
// time: once `changeset version` writes 0.79.0 into `package.json` and consumes
// the changeset, the fallback path reads the same 0.79.0.
//
// The bumps are read from `.changeset/*.md` directly rather than by spawning
// `changeset status`: this runs on every workspace install, and loading the whole
// changesets graph to answer one question about one package is not worth the
// install time. What that trades away is a bump INDUCED by a dependency
// (`updateInternalDependencies: "patch"`), which is by definition a patch and
// therefore never the release that introduces syntax — the case this exists for.
// The gate is also one-directional: `maxVersion` keeps the answer from ever going
// backwards from what `package.json` already states.
//
// Runs from BOTH the root `prepare` (pnpm, on workspace install, so a fresh clone
// builds) and the analyzer package's own `prepare` (npm, before pack/publish, so
// a published tarball carries it). The analyzer-level one is not redundant: the
// root script is not part of the analyzer's tarball lifecycle, so without it the
// published copy would depend entirely on a prior workspace install having
// happened in the same tree.
//
// The destination is gitignored AND must stay untracked — `.gitignore` has no
// effect on a tracked file, so committing it once would silently turn it into a
// second place the version lives, stale after every bump and dirty in every
// contributor tree.
//
// Usage: node scripts/generate-telo-version.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "cli", "nodejs", "package.json");
const DEST = join(ROOT, "analyzer", "nodejs", "src", "telo-version.ts");
const CLI_PACKAGE = "@telorun/cli";

// A missing source is a packaging mistake, never a reason to emit a placeholder.
// Writing "0.0.0" would make every module's `requires.telo` unsatisfiable and
// every manifest fail to load — or, with the safe-direction fallback, switch the
// check off silently for the entire build. Neither is a state worth shipping.
if (!existsSync(SOURCE)) {
  console.error(
    `generate-telo-version: '${SOURCE}' does not exist. The surface generation is read from ` +
      `the linked CLI package's version; without it the analyzer cannot say which version ` +
      `of the manifest surface it implements.`,
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(SOURCE, "utf8"));

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-.+)?$/.test(version)) {
  console.error(
    `generate-telo-version: CLI version '${version}' is not a three-part semantic version.`,
  );
  process.exit(1);
}

/** The packages whose bump moves the CLI's version: its changesets `linked`
 *  group, read from config rather than hardcoded, so the set cannot drift from
 *  the one `changeset version` actually applies. */
function linkedWithCli() {
  const names = new Set([CLI_PACKAGE]);
  try {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"));
    for (const group of config.linked ?? []) {
      if (Array.isArray(group) && group.includes(CLI_PACKAGE)) {
        for (const name of group) names.add(name);
      }
    }
  } catch {
    // No config, or unreadable: the CLI alone still answers the question for a
    // changeset that names it directly.
  }
  return names;
}

/** The strongest bump any pending changeset declares for the linked group, or
 *  undefined when none does. The front matter is a YAML mapping of
 *  `"name": bump`, one per line — the same shape `check-changeset-status.mjs`
 *  reads. */
function pendingBump() {
  const dir = join(ROOT, ".changeset");
  if (!existsSync(dir)) return undefined;
  const linked = linkedWithCli();
  const rank = { patch: 1, minor: 2, major: 3 };
  let strongest;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const frontMatter = readFileSync(join(dir, file), "utf8").split(/^---$/m)[1];
    if (!frontMatter) continue;
    for (const line of frontMatter.split("\n")) {
      const match = /^\s*["']?(@?[^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (!match || !linked.has(match[1].trim())) continue;
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
  const [major, minor, patch] = base.replace(/-.*$/, "").split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The higher of two versions, so a pending bump can only ever move the surface
 *  generation forward. */
function maxVersion(a, b) {
  const parse = (v) => v.replace(/-.*$/, "").split(".").map(Number);
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (am !== bm) return am > bm ? a : b;
  if (an !== bn) return an > bn ? a : b;
  return ap >= bp ? a : b;
}

const bump = pendingBump();
const surface = bump ? maxVersion(version, applyBump(version, bump)) : version;

const contents = `// GENERATED by scripts/generate-telo-version.mjs — do not edit.
//
// The manifest SURFACE GENERATION this build implements, read from the linked
// cli/kernel/sdk version. Distinct from this package's own npm version: that is
// its release identity, this is the scale a module's \`requires.telo\` range is
// written against, and every kernel in every language reports the same scale.

/** The surface generation this analyzer implements. */
export const TELO_SURFACE_VERSION = ${JSON.stringify(surface)};
`;

// Idempotent: skip the write when unchanged, so a no-op install does not churn
// mtimes and retrigger every downstream build that watches this file.
if (existsSync(DEST) && readFileSync(DEST, "utf8") === contents) {
  process.exit(0);
}

writeFileSync(DEST, contents);
console.log(
  `generate-telo-version: wrote surface generation ${surface}` +
    (bump ? ` (${version} plus a pending ${bump} bump)` : ""),
);
