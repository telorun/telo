#!/usr/bin/env node
// Run from a published package's `prepack` / `postpack` hooks. A pack makes the
// payload that ships — the exact identity, a fresh `dist`, a `package.json` with
// its overrides baked — by writing over files of the working tree; `--save`
// copies each path the pack is about to write (a file or a directory, or the fact
// that it is absent) aside, and `--restore` puts every one back byte for byte, so
// a pack leaves the working tree as it found it. Nothing is regenerated or
// rebuilt on restore. The copies live under the package's `node_modules`, as the
// link rewrite's do (`rewrite-pack-links.mjs`).
//
// Usage: node scripts/pack-backup.mjs <pkg-dir> --save <path>...
//        node scripts/pack-backup.mjs <pkg-dir> --restore

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKUP = join("node_modules", ".telo-pack-backup");
const INDEX = "index.json";

function fail(message) {
  console.error(`pack-backup: ${message}`);
  process.exit(1);
}

const [dirArg, mode, ...paths] = process.argv.slice(2);
if (!dirArg || (mode !== "--save" && mode !== "--restore")) {
  fail("usage: pack-backup.mjs <pkg-dir> --save <path>... | --restore");
}
const pkg = resolve(dirArg);
const backup = join(pkg, BACKUP);

if (mode === "--save") {
  if (paths.length === 0) fail("--save names no path.");
  if (existsSync(join(backup, INDEX))) {
    fail(`${join(backup, INDEX)} exists: an earlier pack saved files it never restored. Run --restore first, or the originals are lost.`);
  }
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });
  const saved = [];
  paths.forEach((path, index) => {
    const source = join(pkg, path);
    const present = existsSync(source);
    if (present) cpSync(source, join(backup, String(index)), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    saved.push({ path, present });
  });
  writeFileSync(join(backup, INDEX), JSON.stringify(saved, null, 2) + "\n");
} else {
  const index = join(backup, INDEX);
  if (!existsSync(index)) fail(`${index} does not exist: no prepack saved what this pack wrote.`);
  const saved = JSON.parse(readFileSync(index, "utf8"));
  saved.forEach(({ path, present }, position) => {
    const target = join(pkg, path);
    rmSync(target, { recursive: true, force: true });
    if (present) cpSync(join(backup, String(position)), target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  });
  rmSync(backup, { recursive: true, force: true });
}
