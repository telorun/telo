/**
 * The cutover's gate: a census of every diagnostic `telo check` reports over every manifest
 * in the repository, as `(file, line, column, code)`.
 *
 * "No manifest was edited" was the first gate proposed for the engine swap, and it is a
 * PROXY: it is blind to a verdict that DISAPPEARS. A manifest that reported a warning before
 * the swap and reports nothing after is edited by nobody and is exactly the regression the
 * swap can cause. So the census is taken before, taken again after, and diffed — a verdict
 * that appears, disappears or moves by one column is a finding either way.
 *
 *   node scripts/cel-cutover-census.mjs > .census/<before|after>.txt
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Exactly what `pnpm run ci` checks, plus every test manifest in the repo — the negative
// fixtures are where a CEL verdict actually lives, so leaving them out would census the
// clean half of the corpus and call it the corpus.
const PATTERNS = [
  "modules/*/telo.yaml",
  "examples/*/telo.yaml",
  "apps/*/telo.yaml",
  "starters/apps/*/telo.yaml",
  "starters/libs/*/telo.yaml",
  "blueprints/*/telo.yaml",
  "benchmarks/*/api.yaml",
  "benchmarks/*/benchmark.yaml",
  "tests/*.yaml",
  "modules/*/tests/*.yaml",
  "examples/*/tests/*.yaml",
  "starters/*/*/tests/*.yaml",
  // **Where the verdicts actually are.** Over the real manifests the census finds three CEL
  // diagnostics in all, because a repo manifest is meant to be correct; the negative
  // fixtures are the corpus that exercises a refusal, so a census without them pins the
  // clean half and calls it the whole.
  "tests/__fixtures__/**/*.yaml",
  "modules/*/tests/__fixtures__/**/*.yaml",
  "examples/*/tests/__fixtures__/**/*.yaml",
  "apps/*/tests/__fixtures__/**/*.yaml",
];

const paths = [...new Set(PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: root })))].sort();
const rows = [];
const failures = [];

for (const path of paths) {
  const result = spawnSync(
    "node",
    ["./cli/nodejs/bin/telo.mjs", "check", "-o", "json", "--no-cache-write", path],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // A check that could not even report is itself a census row: it must still not report
    // after the swap, and a swap that makes one readable is as much a change as one that
    // breaks a reading.
    failures.push(`${path}\tUNPARSEABLE\t${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`);
    continue;
  }
  for (const held of report.diagnostics ?? []) {
    const where = held.file ?? held.path ?? path;
    const line = held.line ?? held.range?.start?.line ?? "-";
    const column = held.column ?? held.range?.start?.column ?? "-";
    rows.push(`${where}\t${line}\t${column}\t${held.code ?? held.severity ?? "?"}`);
  }
}

rows.sort();
failures.sort();
console.log(`# ${paths.length} manifests checked, ${rows.length} diagnostics, ${failures.length} unreadable`);
for (const row of rows) console.log(row);
for (const row of failures) console.log(row);
