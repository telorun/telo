// A second `--save` never overwrites the backup of an unfinished pack.
// Run: node --test scripts/tests/pack-backup.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "pack-backup.mjs");
const backup = (pkg, ...args) => spawnSync(process.execPath, [SCRIPT, pkg, ...args], { encoding: "utf8" });

it("refuses --save while an earlier backup is unrestored, and keeps the original", () => {
  const pkg = mkdtempSync(join(tmpdir(), "pack-backup-"));
  writeFileSync(join(pkg, "package.json"), "original");
  assert.equal(backup(pkg, "--save", "package.json").status, 0);
  writeFileSync(join(pkg, "package.json"), "modified by a failed prepack");

  const second = backup(pkg, "--save", "package.json");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /--restore/);

  assert.equal(backup(pkg, "--restore").status, 0);
  assert.equal(readFileSync(join(pkg, "package.json"), "utf8"), "original");
});
