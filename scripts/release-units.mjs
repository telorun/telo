#!/usr/bin/env node
// The release units a Publish run releases, read from its RELEASE COMMIT: the tip
// when it moved a unit's version and is no record commit, else the newest
// `chore(release): version` commit beneath it (`version-commit.mjs`), so a fix pushed
// onto the branch after the release PR merged still releases what that PR versioned.
//
// What moved is `.changes/ledger.yaml` against the commit's first parent: `telo
// release apply` records every unit it versions there — a final as the entry's
// `version`, a candidate as its `candidate.version` — so the ledger, not a diff of
// manifests, says which units a commit released and at which version. Each moved
// unit is then given one row per package it ships, from `telo release order`:
// `{ key, name, version, ecosystem }`, `name` being what the ecosystem publishes it
// as (the npm package, the crate, or the image, chart or module destination).
//
// Usage: node scripts/release-units.mjs        writes `commit` and `units` (JSON) as step outputs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { setOutput } from "./release-actions-output.mjs";
import { releaseCommitOfCommit } from "./release-commit.mjs";
import { isRecordCommit, newestVersionCommit } from "./version-commit.mjs";
import { ROOT } from "./version-line.mjs";

export const LEDGER = ".changes/ledger.yaml";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Each unit's recorded final and candidate versions at `rev`; empty when the
 *  ledger is absent there. */
export function ledgerVersionsAt(cwd, rev) {
  let text;
  try {
    text = git(cwd, "show", `${rev}:${LEDGER}`);
  } catch {
    return new Map();
  }
  const units = parse(text)?.units ?? {};
  return new Map(
    Object.entries(units).map(([key, entry]) => [key, { version: entry?.version, candidate: entry?.candidate?.version }]),
  );
}

/** The units `commit` moved against its first parent: `[{ key, version }]`, the
 *  candidate version for a unit the commit versioned as a candidate. */
export function movedVersions({ cwd = ROOT, commit }) {
  const before = ledgerVersionsAt(cwd, `${commit}^`);
  const moved = [];
  for (const [key, after] of ledgerVersionsAt(cwd, commit)) {
    const was = before.get(key);
    if (after.candidate !== undefined && after.candidate !== was?.candidate) moved.push({ key, version: after.candidate });
    else if (after.version !== undefined && after.version !== was?.version) moved.push({ key, version: after.version });
  }
  return moved.sort((a, b) => a.key.localeCompare(b.key));
}

/** The release commit of the run at `cwd`'s HEAD, or undefined: HEAD — or, at a
 *  publication commit, its first parent — when it moved a unit and is no record
 *  commit, else the newest `chore(release): version` commit beneath it that did. */
export function releaseCommit({ cwd = ROOT } = {}) {
  const moves = (sha) => movedVersions({ cwd, commit: sha }).length > 0;
  const own = releaseCommitOfCommit({ cwd, commit: "HEAD" });
  if (!isRecordCommit({ cwd, commit: own }) && moves(own)) return own;
  return newestVersionCommit({ cwd, paths: [LEDGER], moves });
}

/** What a row of `telo release order` publishes as. */
export function publishedName(row, read = (file) => readFileSync(join(ROOT, file), "utf8")) {
  switch (row.ecosystem) {
    case "npm":
      return JSON.parse(read(`${row.path}/package.json`)).name;
    case "cargo":
      return /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(read(`${row.path}/Cargo.toml`))?.[1] ?? row.path;
    case undefined:
      return row.key;
    default:
      return row.destination ?? row.path;
  }
}

/** One row per package of every unit `moved` names, in publish order. */
export function movedUnits({ moved, order, read }) {
  const versions = new Map(moved.map((unit) => [unit.key, unit.version]));
  return order
    .filter((row) => versions.has(row.key))
    .map((row) => ({
      key: row.key,
      name: publishedName(row, read),
      version: versions.get(row.key),
      ...(row.ecosystem ? { ecosystem: row.ecosystem } : {}),
    }));
}

/** `telo release order`, from the workspace CLI. */
export function releaseOrder({ cwd = ROOT } = {}) {
  return JSON.parse(
    execFileSync(process.execPath, ["./cli/nodejs/bin/telo.mjs", "release", "order", "-o", "json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).order;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const commit = releaseCommit();
    const units = commit ? movedUnits({ moved: movedVersions({ commit }), order: releaseOrder() }) : [];
    setOutput("commit", commit ?? "");
    setOutput("units", JSON.stringify(units));
    console.log(
      commit
        ? `release-units: ${commit.slice(0, 12)} released ${units.length} package(s) of ${new Set(units.map((u) => u.key)).size} unit(s).`
        : "release-units: no commit on this branch released a unit.",
    );
  } catch (error) {
    console.error(`::error::release-units: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
