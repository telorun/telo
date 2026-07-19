#!/usr/bin/env node
// Push EVERY module manifest at its current version to an OCI registry, in
// dependency order.
//
// Why this exists — the release path alone cannot bootstrap an OCI mirror.
// `publish-packages.mjs` only pushes manifests whose `metadata.version` moved in
// HEAD^..HEAD, but `telo publish` hard-fails when a canonicalized relative
// import does not already resolve at the destination. 22 of the stdlib's 52
// modules import a sibling relatively (`cache-redis` → `../cache`), so on an
// empty registry each of those fails unless its sibling happens to be in the
// same release. The version gate then means a failed module is not retried until
// its own version moves again, leaving the mirror permanently partial and
// re-failing every release.
//
// So: run this ONCE against the destination BEFORE setting TELO_OCI_REGISTRY in
// the repo, and again any time the mirror needs repairing. Pushing an unchanged
// module is harmless — same bytes, same tag, same digest.
//
// Usage: TELO_OCI_REGISTRY=oci://ghcr.io/telorun node scripts/publish-oci-backfill.mjs
//        (add --dry-run to list the push order without publishing)
// Env:   TELO_OCI_REGISTRY (required) — OCI base; the repo is <base>/<module-dir>
//        TELO_REGISTRY (default https://registry.telo.run) — resolves non-OCI imports
// Auth:  the ambient Docker credential chain (`docker login ghcr.io`).

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { orderByDependencies } from "./module-publish-order.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = process.env.TELO_REGISTRY ?? "https://registry.telo.run";
const ociRegistry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
const dryRun = process.argv.includes("--dry-run");

if (!ociRegistry) {
  console.error("TELO_OCI_REGISTRY is required (e.g. oci://ghcr.io/telorun).");
  process.exit(1);
}

const modulesDir = join(ROOT, "modules");
const manifests = readdirSync(modulesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(modulesDir, e.name, "telo.yaml"))
  .filter((p) => existsSync(p));

if (manifests.length === 0) {
  console.error(`No module manifests found under ${modulesDir}.`);
  process.exit(1);
}

const publishOrder = orderByDependencies(manifests);

console.log(`\nBackfilling ${publishOrder.length} module manifest(s) to ${ociRegistry}:`);
for (const m of publishOrder) console.log(`  ${m.replace(ROOT + "/", "")}`);
console.log("");

if (dryRun) {
  console.log("--dry-run: nothing published.");
  process.exit(0);
}

// Unlike the release path, a backfill STOPS on the first failure. The whole
// point is to establish a fully resolvable tree, and every module after a
// failure may depend on the one that just failed — continuing would produce a
// cascade of identical "sibling does not resolve" errors that bury the real
// cause.
const failures = [];
for (const m of publishOrder) {
  const rel = m.replace(ROOT + "/", "");
  const destination = `${ociRegistry}/${basename(dirname(m))}`;
  try {
    execSync(
      `node ./cli/nodejs/bin/telo.mjs publish --skip-controllers --registry=${registry} ${destination} ${m}`,
      { stdio: "inherit", cwd: ROOT },
    );
  } catch (err) {
    failures.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
    console.error(`\n  backfill failed at ${rel} — stopping (dependents would cascade).`);
    break;
  }
}

if (failures.length > 0) {
  console.error(`\nBackfill incomplete:`);
  for (const f of failures) {
    console.error(`  ${f.path}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  console.error(`\nFix the cause and re-run — already-pushed modules re-push harmlessly.`);
  process.exit(1);
}

console.log(`\nBackfill complete: ${publishOrder.length} module(s) on ${ociRegistry}.`);
