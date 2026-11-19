#!/usr/bin/env node
// Renovate post-upgrade task: add a pending release fragment for every unit the update reaches
// and that has none yet, so the update PR passes `telo release check` as opened.
//
// The units are the ones `telo release status` names in its CHANGELOG_ENTRY_REQUESTED warning.
// Runs in Renovate's clone of the branch it is updating, with `telo` on PATH: the CLI the
// workflow built from the default branch, whose analyzer reads the clone. `release status`
// packs every unit (each `prepack` runs `tsc`) and reads every platform's crates with
// `cargo metadata --locked --offline`, so the clone is prepared first as the release gate
// of test.yml prepares its checkout.
//
// Usage: node scripts/renovate-release-fragments.mjs --kind <Security|Fixed> --body <text>

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const KINDS = ["Security", "Fixed"];
const MISSING = /this release: (.+?)\. One `release add`/s;

export function missingUnits(status) {
  const warning = (status.diagnostics ?? []).find((d) => d.code === "CHANGELOG_ENTRY_REQUESTED");
  if (!warning) return [];
  const match = MISSING.exec(warning.message);
  if (!match) throw new Error(`CHANGELOG_ENTRY_REQUESTED has an unreadable message: ${warning.message}`);
  return match[1].split(", ").map((unit) => unit.trim());
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit", env: { ...process.env, CI: "true" } });
}

// A fresh clone has no node_modules, no built packages and no fetched crates.
function prepareClone() {
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["-r", "--if-present", "build"]);
  run("cargo", ["fetch", "--locked"]);
  run("cargo", ["fetch", "--locked", "--manifest-path", "apps/studio/src-tauri/Cargo.toml"]);
}

function main() {
  const { values } = parseArgs({ options: { kind: { type: "string" }, body: { type: "string" } } });
  if (!KINDS.includes(values.kind)) throw new Error(`--kind must be one of ${KINDS.join(", ")}`);
  if (!values.body) throw new Error("--body is required");

  // Shallow clones lack the base ref `status` diffs against.
  run("git", ["fetch", "--quiet", "origin", "main:refs/remotes/origin/main"]);
  prepareClone();
  const out = execFileSync("telo", ["-o", "json", "release", "status"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const units = missingUnits(JSON.parse(out));
  if (units.length === 0) return;
  run("telo", ["release", "add", ...units.flatMap((unit) => ["--unit", unit]), "--kind", values.kind, "--body", values.body]);
}

main();
