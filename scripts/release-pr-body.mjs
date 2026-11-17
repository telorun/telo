#!/usr/bin/env node
// The body of a release PR: what the workflow says first (Publish final release's
// own lines), a line saying whether merging it publishes candidates or finals and
// pointing to the PR's diff, then the plan's document `telo release apply -o
// markdown` wrote.
//
// GitHub refuses a body over 65536 characters rather than truncating it, so the
// document's budget is that limit less what precedes it and the headroom the PR
// action appends: `--budget` prints it for the apply's `--max-length`, and the
// planner shortens the document in stated stages to fit.
//
// Usage: node scripts/release-pr-body.mjs --budget [--candidate] [--preamble <file>]
//        node scripts/release-pr-body.mjs <document.md> [--candidate] [--preamble <file>] [> body.md]

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** GitHub's limit on a pull request body. */
export const BODY_LIMIT = 65_536;

/** Room left for what `create-pull-request` appends to the body. */
export const ACTION_HEADROOM = 536;

function introLine(candidate) {
  return candidate
    ? "Merging this publishes the **candidates** below: every version is `<final>-rc.<k>` and moves no pointer. " +
        "Each unit's version and `.changes/ledger.yaml` are in this PR's diff."
    : "Merging this publishes the **finals** below. Each unit's version, its CHANGELOG and `.changes/ledger.yaml` are in this PR's diff.";
}

/** Everything the body holds before the plan's document. */
function bodyHead({ candidate, preamble }) {
  return `${preamble ? `${preamble.trimEnd()}\n\n` : ""}${introLine(candidate)}\n\n`;
}

/** The most code points the plan's document may take. */
export function documentBudget({ candidate, preamble }) {
  return BODY_LIMIT - ACTION_HEADROOM - [...bodyHead({ candidate, preamble })].length;
}

export function composeReleasePrBody({ candidate, preamble, document }) {
  return `${bodyHead({ candidate, preamble })}${document}`;
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const preambleFile = option(args, "--preamble");
    const head = { candidate: args.includes("--candidate"), preamble: preambleFile ? readFileSync(preambleFile, "utf8") : undefined };
    if (args.includes("--budget")) {
      process.stdout.write(`${documentBudget(head)}\n`);
    } else {
      const [documentFile] = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--preamble");
      if (!documentFile) throw new Error("usage: release-pr-body.mjs <document.md> | --budget [--candidate] [--preamble <file>]");
      process.stdout.write(composeReleasePrBody({ ...head, document: readFileSync(documentFile, "utf8") }));
    }
  } catch (error) {
    console.error(`::error::release-pr-body: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
