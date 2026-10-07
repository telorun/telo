#!/usr/bin/env node
// Renders the body of the import-sync pull request from the result envelope of
// `node scripts/upgrade-imports.mjs --pin-local --output=json`.
//
// The reader is deciding whether to merge, so it leads with what is still relative and why — those
// are the imports the job could not finish — then what it rewrote.
//
// Usage: node scripts/sync-imports-pr-body.mjs <envelope.json> > body.md
// Env:   RUN_URL — the workflow run, linked when the run reported errors.

import { readFileSync } from "node:fs";

// GitHub rejects a body over 65536 characters outright rather than truncating it.
const BODY_LIMIT = 60000;

const envelope = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const repins = envelope.repins ?? [];
const pending = envelope.pendingLocal ?? [];
const upgrades = envelope.upgrades ?? [];

/** Rows grouped under the manifest that holds them, manifests in path order. */
function byManifest(entries, row) {
  const groups = new Map();
  for (const entry of entries) {
    const rows = groups.get(entry.manifest) ?? [];
    rows.push(row(entry));
    groups.set(entry.manifest, rows);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([manifest, rows]) => `- \`${manifest}\`\n${rows.map((r) => `  - ${r}`).join("\n")}`)
    .join("\n");
}

const sections = [
  "Opened by the `Sync imports` workflow. It rewrites relative imports of released modules to " +
    "their published pin once the change they were written for has shipped, and moves pinned " +
    "imports to the latest published version this runtime can host.",
];

if (envelope.errorCount > 0) {
  sections.push(
    `> **${envelope.errorCount} import(s) could not be decided.** ` +
      (process.env.RUN_URL ? `The reasons are in [the run](${process.env.RUN_URL}).` : ""),
  );
}

if (pending.length > 0) {
  sections.push(
    `## Still relative (${pending.length})\n\n` +
      "Each of these names a module whose published artifact is not the working copy yet. " +
      "They are rewritten by the first run after that module's release is published.\n\n" +
      byManifest(pending, (p) => `\`${p.source}\` — ${p.reason}`),
  );
}

if (repins.length > 0) {
  sections.push(
    `## Relative imports pinned to the published module (${repins.length})\n\n` +
      byManifest(repins, (r) => `\`${r.source}\` → \`${r.to}\``),
  );
}

const upgradeHeading = `## Upgraded (${upgrades.length})`;
if (upgrades.length > 0) {
  sections.push(
    `${upgradeHeading}\n\n` + byManifest(upgrades, (u) => `\`${u.packagePath}\` ${u.from} → ${u.to}`),
  );
}

let body = sections.join("\n\n");
if (body.length > BODY_LIMIT && upgrades.length > 0) {
  // The per-import upgrade list is the one part the diff already shows line for line.
  const moved = new Map();
  for (const u of upgrades) {
    const key = `\`${u.packagePath}\` → ${u.to}`;
    moved.set(key, (moved.get(key) ?? 0) + 1);
  }
  sections[sections.length - 1] =
    `${upgradeHeading}\n\n` +
    [...moved]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => `- ${key} (${count} import${count === 1 ? "" : "s"})`)
      .join("\n");
  body = sections.join("\n\n");
}
if (body.length > BODY_LIMIT) {
  body = `${body.slice(0, BODY_LIMIT)}\n\n_Truncated — the diff is complete._`;
}

process.stdout.write(`${body}\n`);
