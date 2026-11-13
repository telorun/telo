#!/usr/bin/env node
// The patch-only gate: once `v<major>.<minor>.0` is published, `release/<major>.<minor>`
// takes patches only, so a pull request into it may not plan a unit above `patch`.
// Reads `telo release status -o json` and names every unit planned at another level.
//
// Usage: node scripts/release-patch-gate.mjs --base <ref> [--carried-by <ref>]
//        (env GITHUB_BASE_REF: the branch the pull request targets)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RELEASE_BRANCH } from "./release-branch.mjs";
import { ROOT, finalPublished } from "./version-line.mjs";

/** Whether a pull request into `branch` is held to patches: a release branch whose final is out. */
export function patchOnly({ cwd = ROOT, branch }) {
  return RELEASE_BRANCH.test(branch ?? "") && finalPublished({ cwd, branch });
}

/** One finding per planned unit whose level is not `patch`. */
export function nonPatchFindings(statusPayload, branch) {
  return (statusPayload.units ?? [])
    .filter((unit) => unit.level !== "patch")
    .map((unit) => `${unit.key} is planned at '${unit.level}' (${unit.from} -> ${unit.to}); ${branch} takes patch releases only.`);
}

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
  const branch = process.env.GITHUB_BASE_REF;
  if (!patchOnly({ branch })) {
    console.log(`release-patch-gate: ${branch ?? "(no base branch)"} is not a release branch with a published final; nothing to hold to patches.`);
    return;
  }
  const base = argument("base");
  if (!base) throw new Error("--base is required.");
  const carriedBy = argument("carried-by");
  const out = execFileSync(
    process.execPath,
    ["./cli/nodejs/bin/telo.mjs", "release", "status", "-o", "json", "--base", base, ...(carriedBy ? ["--carried-by", carriedBy] : [])],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const findings = nonPatchFindings(JSON.parse(out), branch);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`::error::release-patch-gate: ${finding}`);
    process.exit(1);
  }
  console.log(`release-patch-gate: every planned unit is a patch.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::release-patch-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
