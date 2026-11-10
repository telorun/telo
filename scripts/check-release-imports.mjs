#!/usr/bin/env node
// The release PR's gate on its publication commit: `telo release imports
// --as=published --dry-run` over every consumer manifest (`release-imports.mjs`) must
// leave no import relative for any reason but its version awaiting this release's
// publish. So the publication commit made after the merge fails only on a registry
// error, which a re-run heals.
//
// Allowed: an import kept relative with cause `unpublished` or `never-released` — the
// versions this release publishes. Refused: any error, and any `plan-bumped` import —
// a module the PR leaves with changes its version does not carry.
//
// Usage: pnpm run check:release-imports      (env TELO_CLI, TELO_OCI_REGISTRY)

import { pathToFileURL } from "node:url";
import { consumerManifests, describeImports, releaseImportsJson } from "./release-imports.mjs";

const AWAITING_PUBLISH = new Set(["unpublished", "never-released"]);

/** Why the gate fails over the command's `status` and envelope `result`, one line per
 *  cause, and the imports it lets through. */
export function releaseImportsVerdict({ status, result }) {
  if (status !== 0 && status !== 1) return { failures: [`telo release imports exited ${status ?? "on a signal"}; see its output above.`], awaiting: [] };
  if (result === undefined) return { failures: ["telo release imports printed no JSON result; see its output above."], awaiting: [] };
  const kept = result.keptRelative ?? [];
  const errors = result.errors ?? [];
  const drift = kept.filter((entry) => !AWAITING_PUBLISH.has(entry.cause));
  const failures = describeImports([...errors, ...drift]);
  if (status === 1 && errors.length === 0 && kept.length === 0) {
    failures.push("telo release imports failed and named no import; see its output above.");
  }
  return { failures, awaiting: kept.filter((entry) => AWAITING_PUBLISH.has(entry.cause)) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const manifests = consumerManifests();
    console.error(`check-release-imports: telo release imports --as=published --dry-run over ${manifests.length} manifest(s)`);
    const { failures, awaiting } =
      manifests.length === 0
        ? { failures: [], awaiting: [] }
        : releaseImportsVerdict(releaseImportsJson({ args: ["--as=published", "--dry-run"], manifests }));
    if (awaiting.length > 0) {
      console.log(`check-release-imports: ${awaiting.length} import(s) await this release's publish.`);
    }
    if (failures.length > 0) {
      for (const line of failures) console.log(`::error::check-release-imports: ${line}`);
      console.log(
        `check-release-imports: ${failures.length} import(s) would stay relative in the publication commit. ` +
          "A module the plan still bumps has changes its version does not carry: rebuild the release PR so it versions them. Fix any error named.",
      );
      process.exit(1);
    }
    console.log("check-release-imports: every import is published or awaits this release's publish.");
  } catch (error) {
    console.error(`::error::check-release-imports: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
