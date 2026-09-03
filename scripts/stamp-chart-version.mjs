#!/usr/bin/env node
// Write each Helm chart's `version` and `appVersion` from the package it deploys.
//
// A chart here has no version of its own. It deploys exactly one image built
// from exactly one workspace package, that package's version is already what the
// image's immutable tag is cut from, and a chart-only edit already forces a
// package bump (`check-changeset-status.mjs` attributes any changed file to its
// nearest package directory, so `chart/values.yaml` is a change to
// `@telorun/k8s-runner`). A second number to move would therefore buy nothing
// except a way for the two to disagree about which runner a chart installs.
//
// Run from `version-packages`, right after `changeset version`, so the bump
// lands in the Version PR and is reviewed in the same diff as the changelog —
// the "one version, several files" move `telo release apply` already makes for a
// module (`telo.yaml` + `package.json` + `Cargo.toml`).
//
// `--check` is the PR gate. Without it the two files drift the moment someone
// edits Chart.yaml by hand, and the drift is invisible until an operator
// installs a chart whose appVersion names an image that was never built from it.
//
// Rewrites the two lines in place rather than re-serializing: Chart.yaml carries
// comments explaining exactly this, and a YAML round-trip would reflow them
// (`yaml-source-edit.ts`'s reason, one file at a time).
//
// Usage:
//   node scripts/stamp-chart-version.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every chart in the workspace, with the package whose version it carries. */
const CHARTS = [{ chart: "apps/k8s-runner/chart", pkg: "apps/k8s-runner" }];

const check = process.argv.includes("--check");
const problems = [];
const written = [];

for (const { chart, pkg } of CHARTS) {
  const chartPath = join(ROOT, chart, "Chart.yaml");
  const pkgPath = join(ROOT, pkg, "package.json");
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (!version) {
    problems.push(`${pkg}/package.json has no version`);
    continue;
  }

  // Replace the VALUE and keep the rest of the line: a trailing `# comment` is
  // the author's, and a whole-line rewrite would silently eat it. Both keys hold
  // a semver, so a `#` on the line is always the start of a comment.
  const setValue = (text, key, value) =>
    text.replace(new RegExp(`^(${key}:)([^\n]*)$`, "m"), (_, head, rest) => {
      const hash = rest.indexOf("#");
      if (hash < 0) return `${head} ${value}`;
      const gap = /[ \t]*$/.exec(rest.slice(0, hash))?.[0] ?? " ";
      return `${head} ${value}${gap || " "}${rest.slice(hash)}`;
    });

  const before = readFileSync(chartPath, "utf8");
  const after = setValue(setValue(before, "version", version), "appVersion", `"${version}"`);

  if (!/^version:/m.test(before) || !/^appVersion:/m.test(before)) {
    problems.push(`${chart}/Chart.yaml is missing a top-level version or appVersion key`);
    continue;
  }
  if (after === before) continue;

  if (check) {
    problems.push(
      `${chart}/Chart.yaml does not match ${pkg}/package.json (${version}). ` +
        `Run \`node scripts/stamp-chart-version.mjs\` — a chart's version and appVersion ` +
        `are the deployed package's version, not numbers of their own.`,
    );
    continue;
  }
  writeFileSync(chartPath, after);
  written.push(`${chart}/Chart.yaml → ${version}`);
}

if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.exit(1);
}
process.stdout.write(
  written.length > 0
    ? `stamp-chart-version: ${written.join(", ")}\n`
    : "stamp-chart-version: every chart already matches its package.\n",
);
