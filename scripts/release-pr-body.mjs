#!/usr/bin/env node
// The body of a release PR that versions npm packages and modules both: the body
// changesets/action wrote, then the module release plan as
// `module-release-pr-body.mjs` renders it.
//
// GitHub refuses a body over 65536 characters rather than truncating it, so the
// module section degrades in stated stages until the whole fits: the full section,
// then one line naming every module and its version, then a sentence with the count.
// The changesets half is kept whole; the action already bounds it.
//
// Usage: node scripts/release-pr-body.mjs <changesets-body.md> <plan.json> [> body.md]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_BODY = 65_000;

/** The combined body. `modules` is the rendered module section, `plan` the plan it
 *  was rendered from. A plan moving no module adds nothing. */
export function composeReleasePrBody({ changesets, modules, plan }) {
  const moved = plan.modules ?? [];
  const head = changesets.trimEnd();
  if (moved.length === 0) return `${head}\n`;
  const count = `${moved.length} module${moved.length === 1 ? "" : "s"}`;
  const stages = [
    modules.trim(),
    `Merging this also publishes ${count}: ${moved.map((m) => `\`${m.key}\` ${m.from} → ${m.to}`).join(", ")}.\n\n` +
      "_Listed compactly to fit GitHub's body limit; each module's CHANGELOG in this PR's diff has its entries._",
    `Merging this also publishes ${count}. They did not fit GitHub's body limit: their versions and changelogs ` +
      "are in this PR's diff and `.changes/ledger.yaml`.",
  ];
  for (const section of stages) {
    const body = `${head}\n\n# Modules\n\n${section}\n`;
    if (body.length <= MAX_BODY) return body;
  }
  return `${head}\n\n# Modules\n\n${stages.at(-1)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [changesetsFile, planFile] = process.argv.slice(2);
    if (!changesetsFile || !planFile) throw new Error("usage: release-pr-body.mjs <changesets-body.md> <plan.json>");
    const renderer = join(dirname(fileURLToPath(import.meta.url)), "module-release-pr-body.mjs");
    const modules = execFileSync(process.execPath, [renderer, planFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(
      composeReleasePrBody({
        changesets: readFileSync(changesetsFile, "utf8"),
        modules,
        plan: JSON.parse(readFileSync(planFile, "utf8")),
      }),
    );
  } catch (error) {
    console.error(`::error::release-pr-body: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
