#!/usr/bin/env node
// Write each Helm chart's `version` and `appVersion` from the package it deploys.
//
// A chart here has no version of its own. It deploys exactly one image built
// from exactly one workspace package — or, for a declarative Telo application,
// from exactly one module — that package's version is already what the
// image's immutable tag is cut from, and a chart-only edit already forces a
// package bump (`check-changeset-status.mjs` attributes any changed file to its
// nearest package directory, so `chart/values.yaml` is a change to
// `@telorun/k8s-runner`). A second number to move would therefore buy nothing
// except a way for the two to disagree about which runner a chart installs.
//
// Run from `version-packages`, right after `changeset version`, so the bump
// lands in the Version PR and is reviewed in the same diff as the changelog —
// the "one version, several files" move `telo release apply` already makes for a
// module (`telo.yaml` + `package.json` + `Cargo.toml`). A chart whose version is
// a module's (`manifest:` below) is stamped the same way right after
// `telo release apply`, so its bump lands in the Module Release PR.
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

/** Every chart in the workspace, with what its version is read from: a
 *  workspace package's `package.json`, or a module manifest's `metadata.version`. */
const CHARTS = [
  { chart: "apps/k8s-runner/chart", pkg: "apps/k8s-runner" },
  { chart: "apps/studio/chart", pkg: "apps/studio" },
  { chart: "apps/hub/chart", manifest: "apps/hub/telo.yaml" },
];

/** `metadata.version` of a manifest's module doc. Read by pattern, like the
 *  chart keys below: the file holds custom YAML tags a plain parse refuses. */
function manifestVersion(text) {
  const moduleDoc = text.split(/^---[ \t]*$/m, 1)[0];
  const metadata = /^metadata:[ \t]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/m.exec(moduleDoc)?.[1] ?? "";
  return /^  version:[ \t]*["']?([^"'\s#]+)/m.exec(metadata)?.[1];
}

const check = process.argv.includes("--check");
const problems = [];
const written = [];

for (const { chart, pkg, manifest } of CHARTS) {
  const chartPath = join(ROOT, chart, "Chart.yaml");
  const source = manifest ?? `${pkg}/package.json`;
  const sourceText = readFileSync(join(ROOT, source), "utf8");
  const version = manifest ? manifestVersion(sourceText) : JSON.parse(sourceText).version;
  if (!version) {
    problems.push(`${source} has no version`);
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
      `${chart}/Chart.yaml does not match ${source} (${version}). ` +
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
