#!/usr/bin/env node
// Publish the Helm charts of a release: every `helm` row among the units the release
// commit moved (`release-units.mjs`), packaged from the directory its row names and
// pushed to the OCI registry its destination (`<registry>/<chart name>`) names. `telo
// release apply` wrote the unit's version into the chart's `version` and
// `appVersion`, so the chart names the image tag the same release built. A version
// the registry already serves is skipped, so a re-run pushes only what an earlier
// one did not.
//
// Usage: node scripts/publish-charts.mjs [--dry-run]     env MOVED_UNITS

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseOrder } from "./release-units.mjs";
import { ROOT } from "./version-line.mjs";

/** The charts to push, `{ key, path, destination, version }`, in publish order. */
export function chartsToPublish({ units, order }) {
  const moved = new Map(units.map((unit) => [unit.key, unit.version]));
  return order
    .filter((row) => row.ecosystem === "helm" && moved.has(row.key))
    .map((row) => ({ key: row.key, path: row.path, destination: row.destination, version: moved.get(row.key) }));
}

/** The registry base `helm push` takes: the destination less its chart name. */
export function pushBase(destination) {
  return destination.slice(0, destination.lastIndexOf("/"));
}

function served(destination, version) {
  const result = spawnSync("helm", ["show", "chart", destination, "--version", version], { encoding: "utf8" });
  if (result.status === 0) return true;
  if (/not found|404/i.test(result.stderr)) return false;
  throw new Error(`helm show chart ${destination} --version ${version} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const dryRun = process.argv.includes("--dry-run");
    const charts = chartsToPublish({ units: JSON.parse(process.env.MOVED_UNITS || "[]"), order: releaseOrder() });
    if (charts.length === 0) console.log("publish-charts: the release moved no chart.");
    for (const chart of charts) {
      if (!chart.destination) throw new Error(`${chart.key}: its chart row names no destination.`);
      if (!dryRun && served(chart.destination, chart.version)) {
        console.log(`publish-charts: ${chart.destination}:${chart.version} is published already.`);
        continue;
      }
      console.log(`publish-charts: ${chart.destination}:${chart.version}${dryRun ? " (dry run)" : ""}`);
      if (dryRun) continue;
      const out = mkdtempSync(join(tmpdir(), "telo-chart-"));
      execFileSync("helm", ["package", join(ROOT, chart.path), "--destination", out], { stdio: "inherit" });
      const [packaged] = readdirSync(out).filter((name) => name.endsWith(".tgz"));
      execFileSync("helm", ["push", join(out, packaged), pushBase(chart.destination)], { stdio: "inherit" });
    }
  } catch (error) {
    console.error(`::error::publish-charts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
