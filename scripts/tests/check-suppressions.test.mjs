// check-suppressions: what it refuses and what it lets through, over a scratch tree.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { refusalsFor } from "../check-suppressions.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const TODAY = new Date("2026-11-19T10:00:00Z");

function check(files) {
  const root = mkdtempSync(join(tmpdir(), "check-suppressions-"));
  made.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return refusalsFor({ root, today: TODAY }).map(({ file, entry, reason }) => [file, entry, reason]);
}

const osv = (id, fields = {}) => {
  const f = { reason: '"why"', effectiveUntil: "2027-01-01", ...fields };
  return `[[IgnoredVulns]]\n${id === null ? "" : `id = "${id}"\n`}${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`;
};
const deny = (...entries) => `[advisories]\nversion = 2\nignore = [\n${entries.join(",\n")},\n]\n`;

describe("check-suppressions", () => {
  it("passes complete entries, and a deny.toml that mirrors the Rust ones", () => {
    assert.deepEqual(
      check({
        "osv-scanner.toml": osv("GHSA-5xrq-8626-4rwp") + osv("RUSTSEC-2024-0429", { reason: '"a # b"' }),
        "deny.toml": deny('  { id = "RUSTSEC-2024-0429", reason = "a # b" }'),
        ".trivyignore.yaml": "vulnerabilities:\n  - id: CVE-2026-1234\n    statement: why\n    expired_at: 2027-01-01\n",
      }),
      [],
    );
  });

  it("refuses a missing id, a multi-id and a package-wide ignore", () => {
    const refused = check({
      "osv-scanner.toml": `${osv(null)}${osv("GHSA-5xrq-8626-4rwp, GHSA-82fw-8626-4rwp")}\n[[PackageOverrides]]\nname = "lodash"\nignore = true\n`,
    });
    assert.deepEqual(
      refused.map(([file, , reason]) => [file, reason.replace(/".*"/, "<id>")]),
      [
        ["osv-scanner.toml", "ignores a whole package"],
        ["osv-scanner.toml", "names no advisory id"],
        ["osv-scanner.toml", "<id> is not a single advisory id (a package-wide or multi-id ignore is refused)"],
      ],
    );
  });

  it("refuses a missing or empty reason and a missing expiry", () => {
    assert.deepEqual(check({ "osv-scanner.toml": osv("GHSA-5xrq-8626-4rwp", { reason: '"  "', effectiveUntil: null }) }), [
      ["osv-scanner.toml", "GHSA-5xrq-8626-4rwp", "has no reason"],
      ["osv-scanner.toml", "GHSA-5xrq-8626-4rwp", "has no effectiveUntil"],
    ]);
  });

  it("refuses an expiry past or more than 90 days ahead, and accepts exactly 90", () => {
    assert.deepEqual(
      check({
        "osv-scanner.toml":
          osv("GHSA-2222-3333-4444", { effectiveUntil: "2026-11-19" }) +
          osv("GHSA-2222-3333-4445", { effectiveUntil: "2027-02-18" }) +
          osv("GHSA-2222-3333-4446", { effectiveUntil: "2027-02-17" }),
      }),
      [
        ["osv-scanner.toml", "GHSA-2222-3333-4444", "effectiveUntil 2026-11-19 is already past"],
        ["osv-scanner.toml", "GHSA-2222-3333-4445", "effectiveUntil 2027-02-18 is more than 90 days ahead"],
      ],
    );
  });

  it("holds a Trivy entry to statement and expired_at", () => {
    assert.deepEqual(
      check({ ".trivyignore.yaml": "vulnerabilities:\n  - id: CVE-2026-1234\n    expired_at: 2028-01-01\n" }),
      [
        [".trivyignore.yaml", "vulnerabilities: CVE-2026-1234", "has no statement"],
        [".trivyignore.yaml", "vulnerabilities: CVE-2026-1234", "expired_at 2028-01-01 is more than 90 days ahead"],
      ],
    );
  });

  it("refuses a deny.toml ignore that drifts from osv-scanner.toml, or is crate-wide", () => {
    const refused = check({
      "osv-scanner.toml": osv("RUSTSEC-2024-0429") + osv("RUSTSEC-2024-0370"),
      "deny.toml": deny(
        '  { id = "RUSTSEC-2024-0429", reason = "other" }',
        '  { id = "RUSTSEC-2026-0001", reason = "x" }',
        '  { crate = "glib", reason = "x" }',
      ),
    });
    assert.deepEqual(refused.map(([file, entry, reason]) => [file, entry, reason.slice(0, 20)]), [
      ["deny.toml", "advisories.ignore #3", '"" is not a single a'],
      ["deny.toml", "RUSTSEC-2024-0429", "reason differs from "],
      ["deny.toml", "RUSTSEC-2024-0370", "is in osv-scanner.to"],
      ["deny.toml", "RUSTSEC-2026-0001", "is not an entry of o"],
    ]);
  });
});
