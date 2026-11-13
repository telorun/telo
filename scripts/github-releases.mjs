#!/usr/bin/env node
// The GitHub Release of a Publish run: ONE release per release tag — `v<line
// version>` when the telo line moved, `packages-<x.y>-[rc.]<n>` when other units
// moved without it — naming every unit the release commit moved and grouping their
// changelog entries by change, so a change written into five units reads once.
//
// The units are the ones `release-units.mjs` read from the release commit, so a
// re-run sees exactly what the first run saw, whatever an earlier step reported.
// Modules are released as OCI artifacts and discovered through the hub; their
// changelogs live in their directories and they are left out here.
//
// A `v<version>` release is created as a DRAFT and promoted by the standalone CLI's
// job once every installer is attached and verified; `releases/latest`, which the
// install scripts read, skips drafts. A `packages-*` release has no binaries and is
// created published. A candidate's is a pre-release and never `latest`; a final's or
// patch's is `latest` unless a higher release already is. A release found with a
// body is left alone; one found empty (the standalone job got there first to hang
// its assets) is filled.
//
// Usage: MOVED_UNITS='[{"key":"cli","name":"@telorun/cli","version":"0.85.0","ecosystem":"npm"}]' \
//        RELEASE_TAG=v0.85.0 RELEASE_CHANNEL=final GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo \
//        GITHUB_SHA=… node scripts/github-releases.mjs [--dry-run]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channelOf, githubReleaseFlags } from "./release-channel.mjs";
import { ROOT } from "./version-line.mjs";

const KIND_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/** The section of a unit's CHANGELOG for exactly `version`: everything under its
 *  `## <version> - <date>` heading (or `## <version>`), up to the next one. */
export function changelogSection(text, version) {
  const escaped = version.replace(/[.+]/g, (c) => `\\${c}`);
  const start = text.search(new RegExp(`^## ${escaped}(?: - .*)?\\s*$`, "m"));
  if (start === -1) return "";
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** A section's entries, `{ kind, body }`: each `* ` bullet under a `### <Kind>`
 *  heading, its continuation lines included. */
export function entriesIn(section) {
  const entries = [];
  let kind;
  let current;
  const flush = () => {
    if (current) entries.push({ kind: current.kind, body: current.lines.join("\n").trim() });
    current = undefined;
  };
  for (const line of section.split("\n")) {
    const heading = /^### (\w+)\s*$/.exec(line);
    if (heading) {
      flush();
      kind = heading[1];
      continue;
    }
    if (/^## /.test(line)) continue;
    const bullet = /^[*-] (.*)$/.exec(line);
    if (bullet && kind) {
      flush();
      current = { kind, lines: [bullet[1]] };
      continue;
    }
    if (current) current.lines.push(line.replace(/^ {2}/, ""));
  }
  flush();
  return entries.filter((entry) => entry.body !== "");
}

/** The release body over `units` (`{ key, version }`, one per unit), `readChangelog(key)`
 *  answering each unit's CHANGELOG text or undefined. */
export function renderBody({ units, readChangelog, repository, tag }) {
  const changes = new Map();
  for (const unit of units) {
    for (const entry of entriesIn(changelogSection(readChangelog(unit.key) ?? "", unit.version))) {
      const id = `${entry.kind}\n${entry.body}`;
      const change = changes.get(id) ?? { ...entry, units: [] };
      if (!change.units.includes(unit.key)) change.units.push(unit.key);
      changes.set(id, change);
    }
  }
  const out = ["### Units", "", "| Unit | Version |", "| --- | --- |"];
  for (const unit of units) out.push(`| \`${unit.key}\` | ${unit.version} |`);
  const kinds = [...KIND_ORDER, ...new Set([...changes.values()].map((c) => c.kind).filter((k) => !KIND_ORDER.includes(k)))];
  for (const kind of kinds) {
    const group = [...changes.values()].filter((change) => change.kind === kind);
    if (group.length === 0) continue;
    out.push("", `### ${kind}`);
    for (const change of group) out.push("", `${change.body} — ${change.units.map((key) => `\`${key}\``).join(", ")}`);
  }
  if (changes.size === 0) out.push("", "Released to pick up changes in what these units ship; see the changelogs below.");
  const links = units.map((unit) => `[${unit.key}](https://github.com/${repository ?? "telorun/telo"}/blob/${tag}/${unit.key}/CHANGELOG.md)`);
  out.push("", "---", "", `Changelogs: ${links.join(" · ")}`);
  return out.join("\n");
}

/** One entry per non-module unit of the moved rows, sorted with the CLI first. */
export function releasedUnits(rows) {
  const units = new Map();
  for (const row of rows) {
    if (row.ecosystem === "telo") continue;
    if (!units.has(row.key)) units.set(row.key, { key: row.key, version: row.version });
  }
  return [...units.values()].sort((a, b) => (a.key === "cli" ? -1 : b.key === "cli" ? 1 : a.key.localeCompare(b.key)));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const commit = process.env.GITHUB_SHA;
  const tag = process.env.RELEASE_TAG;
  if (!tag) throw new Error("RELEASE_TAG is not set.");
  let rows;
  try {
    rows = JSON.parse(process.env.MOVED_UNITS || "[]");
  } catch (error) {
    throw new Error(`MOVED_UNITS is not valid JSON: ${error.message}`);
  }
  const units = releasedUnits(Array.isArray(rows) ? rows : []);
  if (units.length === 0) {
    console.log("github-releases: the release moved no unit outside the modules; no GitHub Release.");
    return;
  }
  const github = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  const body = renderBody({
    units,
    repository,
    tag,
    readChangelog: (key) => {
      const file = join(ROOT, key, "CHANGELOG.md");
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
  });
  const line = tag.startsWith("v");
  const name = line ? `Telo ${tag}` : tag;
  console.log(`github-releases: ${tag} — ${units.length} unit(s)${dryRun ? " (dry run)" : ""}.`);
  if (dryRun) {
    console.log(`\n${"=".repeat(72)}\n${name}\n${"=".repeat(72)}\n${body}`);
    return;
  }
  const found = await github(`/releases/tags/${encodeURIComponent(tag)}`);
  if (found.ok) {
    const release = await found.json();
    if ((release.body ?? "").trim().length > 0) {
      console.log(`github-releases: ${tag} already exists and carries a body; nothing to do.`);
      return;
    }
    const filled = await github(`/releases/${release.id}`, { method: "PATCH", body: JSON.stringify({ name, body }) });
    if (!filled.ok) throw new Error(`Filling release ${tag} failed: ${filled.status} ${await filled.text()}`);
    console.log(`github-releases: ${tag} existed with an empty body — filled it.`);
    return;
  }
  if (found.status !== 404) throw new Error(`Checking release ${tag} failed: ${found.status} ${await found.text()}`);

  const version = units.find((unit) => unit.key === "cli")?.version ?? units[0].version;
  const channel = process.env.RELEASE_CHANNEL || channelOf({ cliVersion: version });
  let flags = githubReleaseFlags({ channel: /-rc\./.test(tag) ? "candidate" : channel, version });
  if (!flags.prerelease && line) {
    const latest = await github("/releases/latest");
    if (!latest.ok && latest.status !== 404) throw new Error(`Reading the latest release failed: ${latest.status} ${await latest.text()}`);
    flags = githubReleaseFlags({ channel, version, latestTag: latest.ok ? (await latest.json()).tag_name : undefined });
  }
  const created = await github("/releases", {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: line,
      prerelease: flags.prerelease,
      make_latest: line ? flags.makeLatest : "false",
      ...(commit ? { target_commitish: commit } : {}),
    }),
  });
  if (created.ok) return;
  const detail = await created.text();
  // A release created between the probe and this call is the shape a concurrent re-run takes.
  if (created.status === 422 && detail.includes("already_exists")) {
    console.log(`github-releases: ${tag} (release already exists)`);
    return;
  }
  throw new Error(`Creating release ${tag} failed: ${created.status} ${detail}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::github-releases: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
