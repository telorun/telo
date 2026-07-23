#!/usr/bin/env node
// Run by `changesets/action` as the `publish` script after the Version PR merges.
// 1. `changeset publish` — publishes npm packages whose versions moved and pushes git tags.
// 2. When TELO_OCI_REGISTRY is set, for each modules/<name>/telo.yaml whose own
//    metadata.version moved vs HEAD^, push the manifest to that OCI base via
//    `telo publish --skip-controllers`, one repo per module directory name (`<base>/<dir>`).
//    Controllers were already built/published and PURLs synced by version-packages.mjs; this
//    step only runs static analysis and pushes the manifest. The gate is the manifest's own
//    metadata.version and nothing else — manifest-only modules (no controllers, no
//    nodejs/package.json) publish on exactly the same footing as controller modules. Unset
//    skips the pass entirely. `registry.telo.run` stays the read origin (--registry) so
//    relative sibling refs resolve during the push.
//
// Usage: node scripts/publish-packages.mjs
// Env: TELO_REGISTRY (default: https://registry.telo.run — read origin for sibling refs)
//      TELO_OCI_REGISTRY (no default; e.g. oci://ghcr.io/telorun — unset skips the OCI pass)

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { orderByDependencies } from "./module-publish-order.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const registry = process.env.TELO_REGISTRY ?? "https://registry.telo.run";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// metadata.version of the first YAML document, read from the file's content at a git ref.
// Scoped to everything before the first `---` and to the `metadata:` block so a nested
// Telo.Definition field named `version` can't match. Returns null when the file is absent at
// that ref (newly added module) or declares no metadata.version.
function manifestVersionAt(ref, yamlPath) {
  let content;
  try {
    content = run(`git show ${ref}:${yamlPath}`);
  } catch {
    return null;
  }
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const metaMatch = firstDoc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (!metaMatch) return null;
  const versionMatch = metaMatch[1].match(/^[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+)["']?[ \t]*$/m);
  return versionMatch ? versionMatch[1] : null;
}

// Ordering lives in module-publish-order.mjs, shared with the OCI backfill.

runLive("pnpm changeset publish");

// Only push manifests whose own metadata.version actually moved in HEAD^..HEAD. This gates
// OCI pushes to real release commits — a non-release main push that happens to touch a
// telo.yaml (typo fix, schema edit) won't trigger a republish of an unchanged version. A
// newly added module (absent at HEAD^) publishes on its first commit.
let diff;
try {
  diff = run("git diff --name-only HEAD^ HEAD");
} catch {
  console.log("No prior commit to diff against — skipping OCI push.");
  process.exit(0);
}

const changedYamls = diff
  .split("\n")
  .filter((f) => /^modules\/[^/]+\/telo\.yaml$/.test(f));

const manifests = [];
for (const f of changedYamls) {
  const before = manifestVersionAt("HEAD^", f);
  const after = manifestVersionAt("HEAD", f);
  if (!after) {
    console.log(`  skip ${f}: no metadata.version`);
    continue;
  }
  if (before === after) {
    console.log(`  skip ${f}: metadata.version unchanged (${after})`);
    continue;
  }
  const abs = join(ROOT, f);
  if (existsSync(abs)) manifests.push(abs);
}

if (manifests.length === 0) {
  console.log("No module manifests with a version bump in this commit — nothing to push.");
  process.exit(0);
}

const publishOrder = orderByDependencies(manifests);

// One push pass over the ordered manifests. `destinationFor` maps a manifest to
// the `telo publish` destination positional; `--registry` stays the read origin
// so relative sibling refs resolve during the push. Failures are collected rather
// than thrown so one module can't abort the rest of the release — the HEAD^..HEAD
// gate means a manifest skipped here isn't retried until its version moves again,
// so every manifest must get a shot before the script exits non-zero.
function pushAll(label, destinationFor) {
  console.log(`\nPushing ${publishOrder.length} module manifest(s) to ${label}:`);
  for (const m of publishOrder) console.log(`  ${m.replace(ROOT + "/", "")}`);
  console.log("");

  const failed = [];
  for (const m of publishOrder) {
    const rel = m.replace(ROOT + "/", "");
    const destination = destinationFor(m);
    try {
      runLive(
        `node ./cli/nodejs/bin/telo.mjs publish --skip-controllers --registry=${registry} ` +
          `${destination ? `${destination} ` : ""}${m}`,
      );
    } catch (err) {
      failed.push({ path: rel, target: label, message: err instanceof Error ? err.message : String(err) });
      console.error(`\n  push to ${label} failed for ${rel} — continuing with remaining manifests.`);
    }
  }
  return failed;
}

const failures = [];

// Publish to OCI. `TELO_OCI_REGISTRY` has no default: unset skips the pass
// entirely, so its presence is the gate and a fork or local run never pushes to
// someone else's registry off ambient Docker credentials. The repo is the
// module's directory name under the base — never `metadata.namespace`/`name`,
// since identity is the ref.
const ociRegistry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
if (ociRegistry) {
  failures.push(...pushAll(ociRegistry, (m) => `${ociRegistry}/${basename(dirname(m))}`));
} else {
  console.log("\nTELO_OCI_REGISTRY unset — skipping the OCI publish pass.");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest push(es) failed:`);
  for (const f of failures) {
    console.error(`  ${f.path} → ${f.target}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  process.exit(1);
}
