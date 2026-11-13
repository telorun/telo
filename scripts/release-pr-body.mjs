#!/usr/bin/env node
// The body of a release PR: a line saying whether merging it publishes candidates
// or finals, then the unit section `module-release-pr-body.mjs` renders from the
// plan `telo release apply` printed.
//
// GitHub refuses a body over 65536 characters rather than truncating it, so the
// unit section degrades in stated stages until the whole fits: the full section,
// then one line naming every unit and its version, then a sentence with the count.
//
// Usage: node scripts/release-pr-body.mjs <plan.json> [--candidate] [> body.md]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_BODY = 65_000;

/** The whole body. `units` is the rendered unit section, `plan` the plan it was
 *  rendered from, `candidate` whether the PR versions candidates. */
export function composeReleasePrBody({ units, plan, candidate }) {
  const moved = plan.units ?? [];
  const head = candidate
    ? "Merging this publishes the **candidates** below: every version is `<final>-rc.<k>` and moves no pointer."
    : "Merging this publishes the **finals** below.";
  if (moved.length === 0) return `${head}\n\nNo unit version moved.\n`;
  const count = `${moved.length} unit${moved.length === 1 ? "" : "s"}`;
  const stages = [
    units.trim(),
    `Merging this publishes ${count}: ${moved.map((m) => `\`${m.key}\` ${m.from} → ${m.to}`).join(", ")}.\n\n` +
      "_Listed compactly to fit GitHub's body limit; each unit's CHANGELOG in this PR's diff has its entries._",
    `Merging this publishes ${count}. They did not fit GitHub's body limit: their versions and changelogs ` +
      "are in this PR's diff and `.changes/ledger.yaml`.",
  ];
  for (const section of stages) {
    const body = `${head}\n\n${section}\n`;
    if (body.length <= MAX_BODY) return body;
  }
  return `${head}\n\n${stages.at(-1)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [planFile] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
    if (!planFile) throw new Error("usage: release-pr-body.mjs <plan.json> [--candidate]");
    const renderer = join(dirname(fileURLToPath(import.meta.url)), "module-release-pr-body.mjs");
    const units = execFileSync(process.execPath, [renderer, planFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(
      composeReleasePrBody({
        units,
        plan: JSON.parse(readFileSync(planFile, "utf8")),
        candidate: process.argv.includes("--candidate"),
      }),
    );
  } catch (error) {
    console.error(`::error::release-pr-body: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
