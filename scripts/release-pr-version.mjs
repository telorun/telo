#!/usr/bin/env node
// The version command of the release PR, `chore(release): version` from
// `release-version/<branch>`: Publish and Publish final release both build it with
// this. It decides candidacy (`release-version.mjs`) and runs `telo release apply`
// on the tree — `--candidate` while the branch is in candidates — writing every
// planned unit's version into each of its packages, its changelog on a final, the
// ledger, and the `>=unreleased` floors the line's release names. The plan the
// apply printed, captured before it consumed the fragments, goes to
// RELEASE_PLAN_FILE for the PR body.
//
// Usage: node scripts/release-pr-version.mjs [--final] [--branch <release/x.y>]
//        (env GITHUB_REF_NAME, TELO_OCI_REGISTRY, RELEASE_PLAN_FILE optional)

import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { candidacyFromArgs } from "./release-version.mjs";
import { ROOT } from "./version-line.mjs";

const CLI = ["./cli/nodejs/bin/telo.mjs"];

/** Runs `command`, its stdout to `stdoutFile` when given; throws on a failed exit. */
function runCommand(command, args, { cwd, stdoutFile } = {}) {
  const fd = stdoutFile ? openSync(stdoutFile, "w") : undefined;
  try {
    const result = spawnSync(command, args, { cwd, stdio: ["ignore", fd ?? "inherit", "inherit"] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${[command, ...args].join(" ")} exited ${result.status ?? "on a signal"}.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Versions the release PR's tree at `cwd`; `candidate` decides the apply's flag. */
export function versionReleasePr({ cwd = ROOT, candidate, planFile, run = runCommand }) {
  const apply = [...CLI, "release", "apply", "--base", "HEAD", ...(candidate ? ["--candidate"] : []), ...(planFile ? ["-o", "json"] : [])];
  run(process.execPath, apply, { cwd, ...(planFile ? { stdoutFile: planFile } : {}) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const candidate = candidacyFromArgs(process.argv.slice(2));
    console.log(`release-pr-version: versioning ${candidate ? "candidates" : "finals"}.`);
    versionReleasePr({ candidate, planFile: process.env.RELEASE_PLAN_FILE || undefined });
  } catch (error) {
    console.error(`::error::release-pr-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
