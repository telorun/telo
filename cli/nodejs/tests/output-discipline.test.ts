import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "Every CLI-owned write goes through the `Output` seam" is only worth stating
 * if it is checkable. Without this, nothing stops the next command from writing
 * prose with a bare `process.stdout.write` — which would leak into the machine
 * surface under `-o json` and silently reopen the hole the seam closed. The
 * invariant is mechanical, so it is enforced mechanically rather than by review.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** `output.ts` IS the seam and holds the only legitimate stream writes.
 *
 *  `controller-progress.ts` is exempt for its CURSOR CONTROL only — in-place
 *  rewrites and the DL escape need `moveCursor` / `clearLine` / `cursorTo` on
 *  the real `process.stdout`, which no stream abstraction usefully wraps. Its
 *  prose goes through the seam like everything else, and it returns early under
 *  `-o json`, so it can never write into a machine surface. */
const EXEMPT = new Set([
  path.join(SRC, "output.ts"),
  path.join(SRC, "controller-progress.ts"),
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const BANNED = [
  { pattern: /\bconsole\.(log|error|warn|info)\s*\(/, name: "console.*" },
  { pattern: /\bprocess\.(stdout|stderr)\.write\s*\(/, name: "process.std*.write" },
];

describe("output discipline", () => {
  const files = sourceFiles(SRC).filter((f) => !EXEMPT.has(f));

  it.each(BANNED)("no $name outside the Output seam", ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("keeps every exempt file real, so the list cannot rot", () => {
    // If an exempt file is renamed or removed, this fails rather than quietly
    // letting the exemption cover nothing while a new bypass goes unnoticed.
    for (const file of EXEMPT) expect(() => statSync(file)).not.toThrow();
  });

  it("keeps controller-progress silent under -o json", () => {
    // Its exemption is for cursor control, not for a licence to write prose to
    // a machine surface — `--verbose` forces rendering past the TTY check.
    expect(readFileSync(path.join(SRC, "controller-progress.ts"), "utf8")).toContain(
      "if (out.isJson) return;",
    );
  });
});
