#!/usr/bin/env node
// Push module manifests to the OCI base named by TELO_OCI_REGISTRY, one repo per
// module directory name (`<base>/<dir>`).
//
// SEPARATE FROM THE NPM RELEASE, deliberately. This used to be the tail of
// `scripts/publish-packages.mjs`, which ran `changeset publish` and then decided
// module questions — ordering, presence, payload drift — in the same process. Two
// things were wrong with that:
//
//   * It coupled two INDEPENDENT LEDGERS. Nothing here resolves from npm — the
//     artifacts are built by the workspace CLI (`node ./cli/nodejs/bin/telo.mjs`,
//     `--skip-controllers`) — so there is no ordering requirement between the two
//     in either direction, and there is deliberately no `needs:` edge in the
//     workflow. What the old arrangement DID create was a gate on the npm path
//     demanding module versions be moved first, which failed the release after
//     npm packages and git tags were already out, where nothing could retry it.
//   * `telo release` owns module identity, ordering and drift; a second
//     implementation of the release planner living in the npm publish script drifts
//     from it silently.
//
// So: `pnpm changeset publish` publishes packages, this publishes modules, and the
// payload-drift question stays where it is answered — `telo release status`, whose
// plan is what moves `metadata.version` in the module Version PR. A module whose
// bytes moved without a version bump is therefore reported as a pending bump in
// that PR, not as a failure of an unrelated npm release.
//
// A manifest is pushed when EITHER gate fires:
//   (a) its own metadata.version moved in HEAD^..HEAD — the normal release path, a
//       local git check that needs no registry round-trip and works even if the
//       registry read is momentarily unavailable; and
//   (b) its current metadata.version is not yet published at the OCI repo — a
//       per-version presence check that catches a newly added module whose version
//       was seeded outside this commit and re-tries any version a prior run failed
//       to push. An unchanged, already-published version is never re-pushed, so an
//       ordinary main push (typo fix, schema edit) republishes nothing.
//
// Both gates are idempotent, which is what makes this safe to run on every push to
// main rather than only on a release commit: a failed push heals on the next one.
//
// Manifest-only modules (no controllers, no nodejs/package.json) publish on the same
// footing as controller modules — versions and PURLs were already written by
// `telo release apply`; this only runs static analysis and pushes the manifest.
//
// Usage: node scripts/publish-modules.mjs
// Env: TELO_OCI_REGISTRY (no default; e.g. oci://ghcr.io/telorun — unset skips)

import { execFile, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { promisify } from "node:util";

import { orderByDependencies } from "./module-publish-order.mjs";

const execFileAsync = promisify(execFile);

// Presence checks run concurrently, bounded. This gate walks EVERY module on every
// push to main (it is the repair path — it catches a version seeded out of band and
// retries a push a previous run failed), so serially it was ~52 process spawns plus
// a registry round-trip each, on a job that already pays a full install and build.
// Bounded rather than unbounded because the ceiling here is a remote registry, not
// local CPU: fifty simultaneous anonymous pulls is how a run earns a rate limit,
// and a rate-limited check reports "unanswered" and fails the job by design.
const PRESENCE_CONCURRENCY = 8;

/** Run `worker` over `items` with at most `limit` in flight, preserving input
 *  order in the results. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// stderr is piped, not inherited: execSync's default lets a child's stderr go
// straight to the parent and leaves `err.stderr` unset, so a caller that reports a
// failure can only say "Command failed: node ./cli/...".
function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// metadata.version of the first YAML document, read from the file's content at a git
// ref. Scoped to everything before the first `---` and to the `metadata:` block so a
// nested Telo.Definition field named `version` can't match. Returns null when the file
// is absent at that ref (newly added module) or declares no metadata.version.
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

// Versions already published at an OCI repo, newest first. A repo that does not
// exist yet lists as `[]` (exit 0); "module not found" (some transports, exit 1) is
// likewise treated as "no versions". Any other failure throws so a flaky /
// auth-broken query fails loudly instead of silently skipping a module.
async function ociVersions(dest) {
  let out;
  try {
    ({ stdout: out } = await execFileAsync(
      "node",
      ["./cli/nodejs/bin/telo.mjs", "module", "versions", dest, "--json"],
      { encoding: "utf8", cwd: ROOT },
    ));
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
    if (/not found/i.test(text)) return [];
    throw err;
  }
  const parsed = JSON.parse(out.trim());
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected 'module versions' output for ${dest}: ${out.trim()}`);
  }
  return parsed;
}

// TELO_OCI_REGISTRY has no default: unset skips the pass entirely, so its presence is
// the gate and a fork or local run never pushes to someone else's registry off
// ambient Docker credentials. The repo is the module's directory name under the base
// — never `metadata.namespace`/`name`, since identity is the ref.
const ociRegistry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
if (!ociRegistry) {
  console.log("TELO_OCI_REGISTRY unset — skipping the module publish pass.");
  process.exit(0);
}

const queued = new Set();

// (a) version-moved gate.
let diff = "";
try {
  diff = run("git diff --name-only HEAD^ HEAD");
} catch {
  console.log("No prior commit to diff against — version-move gate skipped (presence gate still runs).");
}
for (const f of diff.split("\n").filter((p) => /^modules\/[^/]+\/telo\.yaml$/.test(p))) {
  const before = manifestVersionAt("HEAD^", f);
  const after = manifestVersionAt("HEAD", f);
  if (!after) {
    console.log(`  skip ${f}: no metadata.version`);
    continue;
  }
  if (before === after) {
    console.log(`  skip ${f}: metadata.version unchanged (${after}) — presence gate still applies`);
    continue;
  }
  const abs = join(ROOT, f);
  if (existsSync(abs)) queued.add(abs);
}

// Presence checks that could not ANSWER — a broken credential, an unreachable
// registry. Distinct from "no versions published", which is a real answer.
const unanswered = [];

// (b) version-absent gate, over every module manifest not already queued by (a).
//
// MODULES ONLY, deliberately — NOT the full `telo-workspace.yaml` set, which also
// declares `apps/*`. An app is released as a container image (see
// `.github/workflows/publish-docker.yml`), not as an OCI module artifact that
// something else imports, so publishing one here would put an artifact in the
// module registry that nothing resolves and that no consumer expects. The
// workspace anchor answers "what does `telo release` version?"; this answers the
// narrower "what is importable?", and the two are different questions.
//
// Ordering still comes from the release model (`orderByDependencies` →
// `telo release order`), so the import graph is never re-derived here — only the
// SET is narrowed.
const allManifests = readdirSync(join(ROOT, "modules"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(ROOT, "modules", e.name, "telo.yaml"))
  .filter((p) => existsSync(p));
const toCheck = allManifests
  .filter((abs) => !queued.has(abs))
  .map((abs) => ({ abs, rel: abs.replace(ROOT + "/", "") }))
  .map((e) => ({ ...e, version: manifestVersionAt("HEAD", e.rel) }))
  .filter((e) => e.version);

const checked = await mapLimit(toCheck, PRESENCE_CONCURRENCY, async (entry) => {
  const dest = `${ociRegistry}/${basename(dirname(entry.abs))}`;
  try {
    return { ...entry, published: await ociVersions(dest) };
  } catch (err) {
    // NOT skipped silently. `ociVersions` throws only when the registry could not
    // answer — a credential problem, a network failure — and a check that could
    // not answer must never read as "already published". This job is the ONLY
    // module publish path, so swallowing it means modules stop publishing
    // indefinitely behind green CI, which is precisely the error swallowing this
    // repo forbids. Collected here and turned into a non-zero exit below, after
    // every module has been attempted, so one broken query does not hide the
    // state of the other fifty.
    return {
      ...entry,
      error: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
});

// Applied in input order, so the log and the queue do not depend on which check
// happened to finish first.
for (const entry of checked) {
  if (entry.error) {
    unanswered.push(`${entry.rel}: ${entry.error}`);
    continue;
  }
  if (!entry.published.includes(entry.version)) {
    console.log(
      `  queue ${entry.rel}: ${entry.version} not yet published to OCI (have: ${entry.published.join(", ") || "none"})`,
    );
    queued.add(entry.abs);
  }
}

// A presence check that could not answer is a failure of this job, not a module
// that happens to be up to date. Reported before anything else, because it is the
// reason the queue below may be short.
if (unanswered.length > 0) {
  console.error(
    `\n${unanswered.length} module${unanswered.length === 1 ? "" : "s"} could not be checked ` +
      `against ${ociRegistry} — their publish state is UNKNOWN, not up to date:`,
  );
  for (const line of unanswered) console.error(`  ${line}`);
}

const manifests = [...queued];
if (manifests.length === 0) {
  if (unanswered.length > 0) {
    // Deliberately NOT "everything is already published" — nothing established
    // that, and saying so is the failure this guard exists to prevent.
    console.error("\nNothing was queued, but the registry could not be reached. Failing.");
    process.exit(1);
  }
  console.log("Every module manifest is already published at its current version — nothing to push.");
  process.exit(0);
}

const publishOrder = orderByDependencies(manifests);

// One push pass over the ordered manifests. Relative sibling imports canonicalize to
// the same OCI base and resolve there, so a sibling must be pushed before its
// dependents. Failures are collected rather than thrown so one module can't abort the
// rest; a failed push leaves its version absent from OCI, so gate (b) retries it.
console.log(`\nPushing ${publishOrder.length} module manifest(s) to ${ociRegistry}:`);
for (const m of publishOrder) console.log(`  ${m.replace(ROOT + "/", "")}`);
console.log("");

const failures = [];
for (const m of publishOrder) {
  const rel = m.replace(ROOT + "/", "");
  const destination = `${ociRegistry}/${basename(dirname(m))}`;
  try {
    runLive(`node ./cli/nodejs/bin/telo.mjs publish --skip-controllers ${destination} ${m}`);
  } catch (err) {
    failures.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
    console.error(`\n  push failed for ${rel} — continuing with remaining manifests.`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest push(es) failed:`);
  for (const f of failures) {
    console.error(`  ${f.path} → ${ociRegistry}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  process.exit(1);
}

// A successful push pass does not clear an unanswered presence check: the modules
// it could not reach were never evaluated, so their state is still unknown and the
// job has not done what it claims to. Reported after the pushes so the run still
// shows what it managed to publish.
if (unanswered.length > 0) {
  console.error(
    `\nPushed what could be evaluated, but ${unanswered.length} presence check(s) never ` +
      `answered — see above. Failing so this does not read as a clean run.`,
  );
  process.exit(1);
}
