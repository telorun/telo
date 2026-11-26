#!/usr/bin/env node
// Copies `analyzer/validation-limits.json` into `@telorun/analyzer`'s source tree.
//
// The limits are canonical at `analyzer/` because every runtime must refuse the
// same values: a value one analyzer validates and another refuses is a manifest
// `telo check` passes and a kernel rejects. The Rust half embeds the file with
// `include_str!`; TypeScript can only import a JSON file from inside its own
// package, so the Node half gets a copy — the `copy-migration-entries.mjs`
// arrangement. The destination is gitignored; the repo holds one copy.
//
// Usage: node scripts/copy-validation-limits.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "analyzer", "validation-limits.json");
const DEST = join(ROOT, "analyzer", "nodejs", "src", "validation-limits.json");

function fail(detail) {
  console.error(`copy-validation-limits: '${SOURCE}' ${detail}`);
  process.exit(1);
}

// A missing source is a packaging mistake, never a reason to validate unbounded.
if (!existsSync(SOURCE)) {
  fail(
    "does not exist. The validation limits are data that ships beside the language halves — " +
      "if this is a container or package build, its file allowlist has to include 'analyzer/validation-limits.json'.",
  );
}

const text = readFileSync(SOURCE, "utf8");
let limits;
try {
  limits = JSON.parse(text);
} catch (err) {
  fail(`is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
}
if (!Number.isSafeInteger(limits?.maxValueDepth) || limits.maxValueDepth < 1) {
  fail("must hold 'maxValueDepth', a positive integer.");
}

writeFileSync(DEST, text, "utf8");
console.log("copy-validation-limits: analyzer/validation-limits.json → analyzer/nodejs/src/");
