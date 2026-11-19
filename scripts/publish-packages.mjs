#!/usr/bin/env node
// Publish the npm packages of the release workspace: every `npm` row of `telo
// release order` whose version npm does not have yet, in the order's sequence (a
// dependency before its dependents), each from the directory its row names with
// `pnpm publish` — so its `prepack` makes the payload, the one the release plan
// digests. A candidate version (`<final>-<id>.<k>`) goes out under the dist-tag
// `<id>` (`rc` by default), any other under `latest`. Every package is published with
// npm provenance, a signed statement of the workflow run that built it, which needs the
// job's OIDC token (`id-token: write`) and a `repository` field naming this repository.
//
// Idempotent: a version npm already holds is skipped, so a re-run publishes only
// what an earlier run did not, and a version a commit merely recorded is not
// republished. The modules publish after this (`publish-modules.mjs`), because a
// module's `requires: telo` floor is measured with a published CLI.
//
// Usage: node scripts/publish-packages.mjs [--dry-run]     env NODE_AUTH_TOKEN
// (provenance is made only inside a GitHub Actions run, so a publish by hand has none)

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseOrder } from "./release-units.mjs";
import { ROOT } from "./version-line.mjs";

/** The dist-tag a version publishes under: its candidate id (`1.2.0-beta.3` -> `beta`), `latest` for a final. */
export function distTagOf(version) {
  const prerelease = /^[^-+]+-([^+]*)/.exec(version)?.[1];
  return prerelease === undefined ? "latest" : prerelease.split(".")[0];
}

/**
 * The npm rows to publish, in order: `{ key, path, name, version, distTag }` for
 * every `npm` row whose `name@version` `isPublished` denies.
 */
export function packagesToPublish({ rows, nameOf, isPublished }) {
  return rows
    .filter((row) => row.ecosystem === "npm")
    .map((row) => ({ key: row.key, path: row.path, name: nameOf(row.path), version: row.version, distTag: distTagOf(row.version) }))
    .filter((pkg) => !isPublished(pkg.name, pkg.version));
}

/** Whether npm serves `name@version`. A registry error other than "not found" fails. */
function isPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim() !== "";
  if (/E404|404 Not Found|is not in this registry/.test(result.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const dryRun = process.argv.includes("--dry-run");
    const queue = packagesToPublish({
      rows: releaseOrder(),
      nameOf: (path) => JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")).name,
      isPublished,
    });
    if (queue.length === 0) console.log("publish-packages: npm holds every package version in the tree.");
    for (const pkg of queue) {
      console.log(`publish-packages: ${pkg.name}@${pkg.version} under '${pkg.distTag}'${dryRun ? " (dry run)" : ""}`);
      if (dryRun) continue;
      execFileSync("pnpm", ["publish", "--tag", pkg.distTag, "--access", "public", "--no-git-checks"], {
        cwd: join(ROOT, pkg.path),
        stdio: "inherit",
        env: process.env.GITHUB_ACTIONS === "true" ? { ...process.env, NPM_CONFIG_PROVENANCE: "true" } : process.env,
      });
    }
  } catch (error) {
    console.error(`::error::publish-packages: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
