#!/usr/bin/env node
/**
 * The host runner's single-file executable: the CLI's standalone build with the
 * runner's entry, so there is one recipe. It is not a `telo` release asset, and
 * the runner's entry declares no carrier, so the result is never one.
 *
 *   node scripts/build-standalone.mjs [--target <os>-<arch>[-musl]] [--out <dir>] [...]
 *
 * Every argument is the CLI recipe's own. This adds what is the runner's: its
 * entry and name, its baked version, and THIRD_PARTY_NOTICES embedded as an
 * asset. Needs the CLI and this package built (`pnpm --filter @telorun/cli
 * --filter @telorun/host-runner build`).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bundleMetafile, noticesFromMetafile, PACKAGE_DIR, readSupplements, REPO_ROOT } from "./third-party-notices.mjs";

const entry = path.join(PACKAGE_DIR, "dist", "entry.js");
if (!fs.existsSync(entry)) throw new Error(`${entry} is missing: build the package first (pnpm --filter @telorun/host-runner build)`);
const version = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")).version;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-host-runner-build-"));
try {
  const metafilePath = path.join(scratch, "meta.json");
  bundleMetafile(metafilePath, entry);
  const notices = path.join(scratch, "THIRD_PARTY_NOTICES");
  fs.writeFileSync(notices, noticesFromMetafile(JSON.parse(fs.readFileSync(metafilePath, "utf8")), REPO_ROOT, REPO_ROOT, readSupplements()));

  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "cli", "nodejs", "scripts", "build-standalone.mjs"),
      "--entry",
      entry,
      "--name",
      "telo-host-runner",
      "--bake",
      `@telorun/host-runner=${version}`,
      "--asset",
      `THIRD_PARTY_NOTICES=${notices}`,
      ...(process.argv.includes("--out") ? [] : ["--out", path.join(PACKAGE_DIR, "dist-standalone")]),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
