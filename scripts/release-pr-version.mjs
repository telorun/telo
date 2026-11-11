#!/usr/bin/env node
// The version command of the release PR, `chore(release): version` from
// `changeset-release/<branch>`: Publish's changesets step and Publish final release
// both build it with this.
//
// It versions the npm packages (`release-version.mjs`, which rewrites `>=unreleased`
// too). Then, unless the tree is in candidates (`.changeset/pre.json` after that
// step), it releases the modules on the same tree: the workspace is reinstalled and
// rebuilt at the versions just written, so the plan digests what the merged commit's
// Publish builds; the plan is captured before `telo release apply` consumes the
// fragments its changelog entries come from (to RELEASE_PLAN_FILE, for the PR body);
// then the apply, then the chart stamps a module's version moves.
//
// Usage: node scripts/release-pr-version.mjs [--final] [--branch <release/x.y>]
//        (arguments go to release-version.mjs; env GITHUB_REF_NAME, TELO_OCI_REGISTRY,
//        RELEASE_PLAN_FILE optional)

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

/**
 * Versions the release PR's tree at `cwd`. `run(command, args, { cwd, stdoutFile })`
 * runs one command. Returns whether the modules were released.
 */
export function versionReleasePr({ cwd = ROOT, args = [], planFile, run = runCommand }) {
  run(process.execPath, [join(cwd, "scripts", "release-version.mjs"), ...args], { cwd });
  if (existsSync(join(cwd, ".changeset", "pre.json"))) {
    console.log("release-pr-version: the branch is in candidates; no module releases.");
    return false;
  }
  run("pnpm", ["install", "--frozen-lockfile"], { cwd });
  run("pnpm", ["-r", "--if-present", "build"], { cwd });
  if (planFile) {
    run(process.execPath, [...CLI, "release", "status", "-o", "json", "--base", "HEAD"], { cwd, stdoutFile: planFile });
  }
  run(process.execPath, [...CLI, "release", "apply", "--base", "HEAD"], { cwd });
  run(process.execPath, [join(cwd, "scripts", "stamp-chart-version.mjs")], { cwd });
  return true;
}

/**
 * The changesets action reads `CHANGELOG.md` beside every `package.json` whose version the
 * version command moved, and crashes on a missing one. `telo release apply` moves the build
 * package of every module it releases, whose changelog is the module's own, so a package
 * with none gets a heading-only file the action reads as an empty entry.
 */
export function stubMissingChangelogs({ cwd = ROOT } = {}) {
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD", "--", "*package.json"], { cwd, encoding: "utf8" });
  if (diff.error) throw diff.error;
  if (diff.status !== 0) throw new Error(`git diff exited ${diff.status ?? "on a signal"}: ${diff.stderr.trim()}`);
  const stubbed = [];
  for (const file of diff.stdout.split("\n").filter(Boolean)) {
    const dir = dirname(join(cwd, file));
    const changelog = join(dir, "CHANGELOG.md");
    if (existsSync(changelog) || !existsSync(join(cwd, file))) continue;
    writeFileSync(changelog, `# ${JSON.parse(readFileSync(join(cwd, file), "utf8")).name}\n`);
    stubbed.push(file);
  }
  return stubbed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (versionReleasePr({ args: process.argv.slice(2), planFile: process.env.RELEASE_PLAN_FILE || undefined })) {
      const stubbed = stubMissingChangelogs();
      console.log(`release-pr-version: stubbed ${stubbed.length} missing changelog(s) for the release action.`);
    }
  } catch (error) {
    console.error(`::error::release-pr-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
