import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, HarnessHost, REPO } from "./harness.js";

/** `telo check -o json` over one entry, as the CLI of this checkout runs it. */
function teloCheck(entry: string): Array<Record<string, unknown>> {
  const run = spawnSync(
    join(REPO, "node_modules", ".bin", "bun"),
    [join(REPO, "cli", "nodejs", "bin", "telo.ts"), "-o", "json", "check", "--no-cache-write", entry],
    { cwd: REPO, encoding: "utf8" },
  );
  if (!run.stdout) throw new Error(`telo check produced no payload: ${run.stderr}`);
  return JSON.parse(run.stdout).diagnostics;
}

const row = (d: { file: string; line: number; column: number; severity: string; code?: string }) =>
  `${d.file}:${d.line}:${d.column} ${d.severity} ${d.code ?? ""}`;

// Owners from the repo's own fixtures: diagnostics in the entry, in a library
// the entry imports, across a stdlib closure, and a clean module with a partial.
const ENTRIES = [
  "tests/__fixtures__/cel-typing-gaps.yaml",
  "tests/__fixtures__/extends-unknown-target.yaml",
  "tests/__fixtures__/library-variables/typo-app.yaml",
  "tests/__fixtures__/base-mismatch/telo.yaml",
  "tests/__fixtures__/stream-argument-mismatch.yaml",
  relative(REPO, join(FIXTURES, "billing", "telo.yaml")),
];

describe("published diagnostics", () => {
  it.each(ENTRIES)("equal telo check's for %s", async (entry) => {
    const host = new HarnessHost();
    await host.start();
    const path = join(REPO, entry);
    host.open(path);
    await host.published(path);

    const engine = [...host.diagnostics()].flatMap(([file, list]) =>
      list.map((d) =>
        row({
          file: relative(REPO, file),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: d.severity === 1 ? "error" : "warning",
          code: d.code,
        }),
      ),
    );
    expect(engine.sort()).toEqual(teloCheck(entry).map((d) => row(d as never)).sort());
  });

  // A module is analysed as a whole, so an edit to its owner can change what a
  // partial reports — and the partial's diagnostics are republished even though
  // nothing was typed into it.
  it("republishes another open document an edit affects", async () => {
    const host = new HarnessHost();
    await host.start();
    const owner = join(FIXTURES, "billing", "telo.yaml");
    const partial = join(FIXTURES, "billing", "handlers.yaml");
    host.open(owner);
    host.open(partial);
    await host.published(partial);
    expect(host.diagnostics().get(partial)).toEqual([]);

    host.change(owner, readFileSync(owner, "utf8").replace("  Ledger: ../ledger\n", ""));
    await host.published(partial, 2);
    expect(host.diagnostics().get(partial)!.map((d) => d.code)).toContain("UNDEFINED_KIND");
  });
});
