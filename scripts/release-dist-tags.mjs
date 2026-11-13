#!/usr/bin/env node
// Moves npm's `rc` dist-tag to a final or patch, forward only.
//
// Candidates publish under `rc` (`publish-packages.mjs` does that), and a final or
// patch publishes under `latest`. Afterwards `rc` follows the final, so
// `@rc` never resolves below `latest`. A pointer that already holds a higher
// version is left alone, so re-running an old publish moves nothing.
//
// Usage: MOVED_UNITS='[{"key":"cli","name":"@telorun/cli","version":"0.85.0","ecosystem":"npm"}]' \
//        RELEASE_CHANNEL=final node scripts/release-dist-tags.mjs [--dry-run]
//        (only the `npm` rows of the moved units are npm packages)

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compareVersions } from "./version-line.mjs";

const POINTER = "rc";

/**
 * The `rc` moves a publish makes: `[{ name, version, from }]`. `tagsOf(name)` is
 * the package's dist-tags as the registry holds them now.
 */
export function planRcMoves({ published, tagsOf }) {
  const moves = [];
  for (const { name, version } of published) {
    if (version.includes("-")) continue; // a prerelease is never a final to follow
    const from = tagsOf(name)[POINTER];
    if (from !== undefined && compareVersions(from, version) >= 0) continue;
    moves.push({ name, version, from });
  }
  return moves;
}

function registryTags(name) {
  try {
    return JSON.parse(execFileSync("npm", ["view", name, "dist-tags", "--json"], { encoding: "utf8" }) || "{}");
  } catch (error) {
    // A package npm does not know yet has no pointers; any other failure is real.
    if (/E404/.test(`${error.stderr ?? ""}${error.message}`)) return {};
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const dryRun = process.argv.includes("--dry-run");
    if (process.env.RELEASE_CHANNEL === "candidate") {
      console.log("release-dist-tags: a candidate publishes under rc already; nothing to move.");
      process.exit(0);
    }
    const units = JSON.parse(process.env.MOVED_UNITS || "[]");
    const published = (Array.isArray(units) ? units : []).filter((unit) => unit.ecosystem === "npm");
    const moves = planRcMoves({ published, tagsOf: registryTags });
    if (moves.length === 0) console.log("release-dist-tags: no rc pointer to move.");
    for (const { name, version, from } of moves) {
      console.log(`release-dist-tags: ${name} rc ${from ?? "(none)"} -> ${version}${dryRun ? " (dry run)" : ""}`);
      if (!dryRun) execFileSync("npm", ["dist-tag", "add", `${name}@${version}`, POINTER], { stdio: "inherit" });
    }
  } catch (error) {
    console.error(`::error::release-dist-tags: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
