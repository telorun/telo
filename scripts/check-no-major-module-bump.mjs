#!/usr/bin/env node
// Mirrors the changeset "no major bumps" guard (test.yml) for changie module fragments.
// Modules are pre-1.0; a major auto-bump (e.g. kind Changed/Removed -> 1.0.0) must be an
// intentional promotion, not a side effect of picking a changelog category. Fails if any
// pending fragment uses a kind whose `auto:` level is major. The major-auto kinds are read
// from .changie.yaml so this stays in sync with the config.
//
// Usage: node scripts/check-no-major-module-bump.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNRELEASED = join(ROOT, ".changes", "unreleased");

const config = readFileSync(join(ROOT, ".changie.yaml"), "utf8");
const kindsBlock = config.match(/^kinds:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
const majorKinds = new Set();
for (const mt of kindsBlock.matchAll(/- label:[ \t]*([^\n]+)\n[ \t]+auto:[ \t]*major\b/g)) {
  majorKinds.add(mt[1].trim());
}

let failed = 0;
if (existsSync(UNRELEASED)) {
  for (const file of readdirSync(UNRELEASED)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const kind = readFileSync(join(UNRELEASED, file), "utf8").match(
      /^kind:[ \t]*["']?([^\s"']+)/m,
    )?.[1];
    if (kind && majorKinds.has(kind)) {
      console.error(
        `::error file=.changes/unreleased/${file}::changie kind "${kind}" auto-bumps a module ` +
          `to a major (1.0.0) version, which is not allowed. Use Added/Fixed for pre-1.0 modules.`,
      );
      failed = 1;
    }
  }
}

process.exit(failed);
