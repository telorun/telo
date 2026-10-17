#!/usr/bin/env node
// Reconcile `<registry>/telo` — the built-in vocabulary of every telo release —
// with what npm holds.
//
// Every release of the telo version line ships its vocabulary inside
// `@telorun/analyzer@X`, at `src/builtin-vocabulary/` (`builtins.yaml` and the
// MIT `LICENSE` beside it), and `oci://<registry>/telo@X` is that directory
// published. So for each analyzer version on npm at or above FLOOR whose tag is
// missing at the registry, this takes the directory out of THAT version's tarball
// and pushes it with the checkout's CLI. Nothing is rendered here and no
// historical CLI runs: the archive and its license are the release's own bytes,
// and `telo publish` appends only the `layers:` index, so the published
// `telo.yaml` minus that block is the archive in `@telorun/analyzer@X`.
//
// Idempotent, which is what lets it run on every push to main: a published
// version is never attempted again, and a failed push heals on the next run. A
// different archive for an existing version cannot happen through here, and the
// pin gate refuses one from anywhere else.
//
// FLOOR is the first release that ships the archive. There is no backfill below
// it: an artifact no release produced cannot be pinned honestly.
//
// Usage: node scripts/publish-builtins.mjs
// Env: TELO_OCI_REGISTRY (no default; e.g. oci://ghcr.io/telorun — unset skips)

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The first `@telorun/analyzer` release carrying `src/builtin-vocabulary/`. */
const FLOOR = "0.119.0";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@telorun/analyzer";
const TELO = join(ROOT, "cli", "nodejs", "bin", "telo.mjs");
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

function compare(a, b) {
  const [, am, an, ap] = RELEASE.exec(a).map(Number);
  const [, bm, bn, bp] = RELEASE.exec(b).map(Number);
  return am - bm || an - bn || ap - bp;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", cwd: ROOT, ...options });
}

// TELO_OCI_REGISTRY is the switch, as it is for module publishing: unset skips,
// so a fork or local run never pushes off ambient credentials.
const registry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
if (!registry) {
  console.log("TELO_OCI_REGISTRY unset — skipping the built-in vocabulary pass.");
  process.exit(0);
}
const destination = `${registry}/telo`;

// At or above FLOOR, and published no earlier than FLOOR was: npm also holds
// 1.x versions of the package from before the line took its 0.x numbering, which
// sort above FLOOR and carry no archive. Until FLOOR itself is published there
// is nothing to reconcile.
const publishedAt = JSON.parse(run("npm", ["view", PACKAGE, "time", "--json"]));
const floorAt = publishedAt[FLOOR];
const released = floorAt
  ? Object.keys(publishedAt)
      .filter(
        (version) =>
          RELEASE.test(version) && compare(version, FLOOR) >= 0 && publishedAt[version] >= floorAt,
      )
      .sort(compare)
  : [];
if (!floorAt) console.log(`${PACKAGE}@${FLOOR}, the first release carrying the archive, is not on npm yet.`);

// A repository that does not exist yet lists as nothing; any other failure is a
// question the registry did not answer, which must not read as "all published".
let published;
try {
  published = JSON.parse(run(process.execPath, [TELO, "module", "versions", destination, "--json"]));
} catch (err) {
  const text = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
  if (!/not found/i.test(text)) throw err;
  published = [];
}

const missing = released.filter((version) => !published.includes(version));
if (missing.length === 0) {
  console.log(`${destination} holds every release at or above ${FLOOR} — nothing to push.`);
  process.exit(0);
}

const failed = [];
for (const version of missing) {
  const work = mkdtempSync(join(tmpdir(), "telo-builtins-"));
  try {
    run("npm", ["pack", `${PACKAGE}@${version}`, "--pack-destination", work], { stdio: ["ignore", "pipe", "inherit"] });
    const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack ${PACKAGE}@${version} wrote no tarball.`);
    run("tar", ["-xzf", join(work, tarball), "-C", work]);
    const archive = join(work, "package", "src", "builtin-vocabulary", "builtins.yaml");
    if (!existsSync(archive)) {
      throw new Error(`${PACKAGE}@${version} carries no src/builtin-vocabulary/builtins.yaml.`);
    }
    console.log(`\nPublishing the built-in vocabulary of telo ${version} → ${destination}`);
    run(process.execPath, [TELO, "publish", destination, archive], { stdio: "inherit" });
  } catch (err) {
    failed.push(`${version}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length} release(s) of the built-in vocabulary were not published:`);
  for (const line of failed) console.error(`  ${line}`);
  process.exit(1);
}
