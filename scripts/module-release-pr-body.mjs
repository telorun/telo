#!/usr/bin/env node
// Renders the release PR's unit section from a release plan: every unit merging
// the PR publishes — npm packages, crates, images, charts and modules alike — the
// version it moves to, and the changelog entries that ship with it.
//
// WHY THE BODY IS GENERATED RATHER THAN STATIC. Merging the release PR publishes
// every unit it lists. A body that says "versions moved" describes the mechanism
// and hides the decision; what a reviewer needs is every unit that will publish,
// its version and its entries. All of that is in the plan `telo release apply`
// printed before it consumed the fragments the entries come from.
//
// Usage: node scripts/module-release-pr-body.mjs <plan.json> [> body.md]

import { readFileSync } from "node:fs";

const KIND_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/** GitHub rejects a PR body over 65536 characters, and the whole point of this
 *  body is that merging publishes what it lists — a request that 422s leaves the
 *  release PR with no body at all. The headroom is for the trailer
 *  `create-pull-request` appends. */
const MAX_BODY = 60_000;

/** Longest a single changelog entry may run before it is cut. Generous, because
 *  these bodies carry the rationale that makes a release reviewable; applied only
 *  when the full body does not fit. */
const MAX_ENTRY = 600;

/** Packages first, then modules, then apps: an app is a deployable rather than a
 *  dependency, so a reviewer scanning for "what will other people consume" reads
 *  the top. */
const SECTIONS = ["Packages", "Modules", "Apps"];
function sectionOf(key) {
  if (key.startsWith("apps/")) return "Apps";
  return /^(modules|blueprints)\//.test(key) ? "Modules" : "Packages";
}

function bulletsFor(entries, entryLimit) {
  const byKind = new Map();
  for (const entry of entries) {
    const kind = KIND_ORDER.includes(entry.kind) ? entry.kind : "Fixed";
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(entry.body);
  }
  const lines = [];
  for (const kind of KIND_ORDER) {
    for (const body of byKind.get(kind) ?? []) {
      // One line per entry: a body spanning several lines breaks the list, and
      // these are changelog sentences rather than prose blocks.
      const text = body.replace(/\s+/g, " ").trim();
      const shown =
        entryLimit && text.length > entryLimit
          ? `${text.slice(0, entryLimit).trimEnd()}… _(trimmed — full text in the unit's CHANGELOG)_`
          : text;
      lines.push(`  - **${kind}** — ${shown}`);
    }
  }
  return lines;
}

/**
 * Build the body at a given level of detail.
 *
 * `entryLimit` cuts long changelog bodies; `tableRows` false collapses the
 * unattributed republishes to a names-only line. Kept as ONE function taking
 * knobs rather than three renderers, so the fallback path is the same code as the
 * full one and cannot drift into describing a different release.
 */
function build(plan, { entryLimit, tableRows }) {
  const units = plan.units ?? [];
  const declared = units.filter((m) => m.entries.length > 0);
  const inferred = units.filter((m) => m.entries.length === 0);

  const out = [];
  out.push(
    `Merging this publishes **${units.length} unit${units.length === 1 ? "" : "s"}** — ` +
      `${declared.length} with a declared change, ${inferred.length} whose payload moved ` +
      "underneath them. Versions, changelogs and `.changes/ledger.yaml` were written by " +
      "`telo release apply`; the ledger records the payload digest each unit ships, so the " +
      "next release compares against what actually published.",
    "",
  );

  if (declared.length > 0) {
    out.push("## Declared changes", "");
    for (const section of SECTIONS) {
      const members = declared.filter((m) => sectionOf(m.key) === section);
      if (members.length === 0) continue;
      if (declared.some((m) => sectionOf(m.key) !== section)) out.push(`### ${section}`, "");
      for (const unit of members) {
        out.push(`**\`${unit.key}\`** &nbsp; ${unit.from} → ${unit.to} _(${unit.level})_`);
        out.push(...bulletsFor(unit.entries, entryLimit));
        out.push("");
      }
    }
  }

  if (inferred.length > 0) {
    out.push(
      "## Republished with no declared change",
      "",
      "Their payload digest moved without anyone describing a change — a shared library, an " +
        "inlined dependency or a toolchain bump reaching what they ship. Expected, and a patch; " +
        "listed so a republish is never silent.",
      "",
    );
    if (tableRows) {
      out.push("| Unit | Version | Why |", "| --- | --- | --- |");
      for (const unit of inferred) {
        const why = [...new Set(unit.reasons ?? [])].filter((r) => r !== "unattributed");
        out.push(
          `| \`${unit.key}\` | ${unit.from} → ${unit.to} | ${why.join(", ") || "payload changed"} |`,
        );
      }
    } else {
      out.push(
        inferred.map((m) => `\`${m.key}\` ${m.to}`).join(", ") + ".",
        "",
        "_Listed compactly — the per-unit reasons did not fit; each unit's CHANGELOG has them._",
      );
    }
    out.push("");
  }

  const diagnostics = plan.diagnostics ?? [];
  if (diagnostics.length > 0) {
    out.push("## Diagnostics", "");
    for (const d of diagnostics) out.push(`- ${typeof d === "string" ? d : JSON.stringify(d)}`);
    out.push("");
  }

  return out.join("\n");
}

/**
 * The body, degraded in STATED stages until it fits.
 *
 * A release that republishes the whole tree with long rationales can exceed
 * GitHub's 65536-character body limit, and an over-long body is not truncated by
 * GitHub — the request fails, so the PR opens with no body at all, which is worse
 * than any amount of trimming. Order of sacrifice follows what a reviewer needs
 * least: first the per-module reasons for republishes nobody described, then the
 * tails of individual entries, and only then a hard cut.
 *
 * Every stage says it trimmed. A body that silently drops modules would claim to
 * list what merging publishes and not do it — the one property this body exists
 * to have.
 */
function render(plan) {
  if ((plan.units ?? []).length === 0) {
    return "No unit version moved — every unit matches the ledger.\n";
  }

  for (const level of [
    { entryLimit: 0, tableRows: true },
    { entryLimit: 0, tableRows: false },
    { entryLimit: MAX_ENTRY, tableRows: false },
    { entryLimit: 200, tableRows: false },
  ]) {
    const body = build(plan, level);
    if (body.length <= MAX_BODY) return body;
  }

  // Nothing fit: keep the head, which carries the counts and the most important
  // declared changes, and say plainly that the rest was cut.
  const body = build(plan, { entryLimit: 200, tableRows: false });
  const notice =
    "\n\n> **Trimmed to fit GitHub's body limit.** The remaining units are in " +
    "`.changes/ledger.yaml` and each unit's CHANGELOG in this PR's diff.\n";
  // Cut on a line boundary: a body ending mid-word reads as corruption rather
  // than as the deliberate trim the notice describes.
  const room = MAX_BODY - notice.length;
  const cut = body.slice(0, room);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > room / 2 ? cut.slice(0, lastBreak) : cut).trimEnd() + notice;
}

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: module-release-pr-body.mjs <plan.json>\n");
  process.exit(2);
}
process.stdout.write(render(JSON.parse(readFileSync(path, "utf8"))));
