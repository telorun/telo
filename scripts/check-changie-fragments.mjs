#!/usr/bin/env node
// Validates the pending changie fragments in .changes/unreleased/.
//
// A fragment is hand-written YAML that nothing reads until release time, so a mistake in one
// surfaces in the Version PR — long after the PR that wrote it merged. The classic case is an
// unquoted `body:` containing a colon ("mapping values are not allowed in this context"), but a
// typo'd `project:` (fragment silently released against no module) or an unknown `kind:` fail
// just as late. This gate moves all of them to the PR that authored the fragment.
//
// Checks per file: parses as YAML, is a mapping, has project/kind/body/time, carries no unknown
// field, and its `project` / `kind` resolve against .changie.yaml.
//
// It also gates the inverse: a module whose files changed in this branch MUST have a pending
// fragment, since a bundled module has no npm version move for the release step to key off.
//
// Usage: node scripts/check-changie-fragments.mjs
// Env: CHANGED_SINCE overrides the base ref the module-change gate diffs against (default origin/main).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineCounter, parseDocument } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNRELEASED = join(ROOT, ".changes", "unreleased");

// changie's Change struct. `project`/`kind`/`body`/`time` are what every fragment in this repo
// writes; the rest are accepted by changie and harmless, but anything outside the set is a typo
// that yaml.v3 would silently drop.
const KNOWN_FIELDS = ["project", "component", "kind", "body", "time", "custom", "env"];
const REQUIRED_FIELDS = ["project", "kind", "body", "time"];

const config = parseDocument(readFileSync(join(ROOT, ".changie.yaml"), "utf8")).toJS();
const projectKeys = (config?.projects ?? []).map((p) => p.key);
const kindLabels = (config?.kinds ?? []).map((k) => k.label);

let failed = 0;

// The annotation's `file=`/`line=` params only reach the PR file view — the workflow log prints
// the message alone. So the path is repeated in the message text, or a failing run says which
// rule broke but not where.
function error(file, message, pos) {
  const path = `.changes/unreleased/${file}`;
  const params = pos ? `,line=${pos.line},col=${pos.col}` : "";
  const where = pos ? `${path}:${pos.line}:${pos.col}` : path;
  console.error(`::error file=${path}${params}::${where} — ${message}`);
  failed = 1;
}

/** Closest known values to a typo'd one, so the error names the fix. */
function didYouMean(value, candidates) {
  if (typeof value !== "string") return "";
  const distance = (a, b) => {
    let prev = [...Array(b.length + 1).keys()];
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  };
  const near = candidates.filter((c) => distance(value.toLowerCase(), c.toLowerCase()) <= 3);
  return near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
}

if (existsSync(UNRELEASED)) {
  for (const file of readdirSync(UNRELEASED).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;

    const lineCounter = new LineCounter();
    // prettyErrors would restate the position inside the message and append a code frame; the
    // annotation already carries both.
    const doc = parseDocument(readFileSync(join(UNRELEASED, file), "utf8"), {
      lineCounter,
      prettyErrors: false,
    });
    const at = (node) =>
      node?.range?.[0] === undefined ? undefined : lineCounter.linePos(node.range[0]);

    if (doc.errors.length > 0) {
      for (const err of doc.errors) {
        // The one failure mode that isn't self-explanatory: a colon inside an unquoted body ends
        // the scalar and reads as a nested mapping key.
        const hint =
          err.code === "BLOCK_AS_IMPLICIT_KEY" || /mapping values are not allowed/.test(err.message)
            ? ' A `body:` containing ": " must be quoted — body: "Publish as a layered artifact: ...".'
            : "";
        error(file, `invalid YAML: ${err.message}.${hint}`, lineCounter.linePos(err.pos[0]));
      }
      continue;
    }

    const items = doc.contents?.items;
    if (!items || !Array.isArray(items) || doc.contents.constructor.name !== "YAMLMap") {
      error(file, "fragment must be a YAML mapping with project / kind / body / time fields.");
      continue;
    }

    const entries = new Map();
    for (const item of items) {
      const key = item.key?.value;
      if (typeof key !== "string") {
        error(file, "fragment keys must be plain strings.", at(item.key));
        continue;
      }
      if (!KNOWN_FIELDS.includes(key)) {
        error(
          file,
          `unknown field \`${key}\` — changie ignores it silently. Accepted fields: ${KNOWN_FIELDS.join(", ")}.${didYouMean(key, KNOWN_FIELDS)}`,
          at(item.key),
        );
        continue;
      }
      entries.set(key, item);
    }

    for (const field of REQUIRED_FIELDS) {
      if (!entries.has(field)) error(file, `missing required field \`${field}\`.`);
    }

    const project = entries.get("project")?.value?.value;
    if (entries.has("project") && !projectKeys.includes(project)) {
      error(
        file,
        `\`project: ${JSON.stringify(project)}\` is not a changie project — see the \`projects:\` list in .changie.yaml (regenerate it with \`node scripts/gen-changie-config.mjs\` after adding a module).${didYouMean(project, projectKeys)}`,
        at(entries.get("project").value),
      );
    }

    const kind = entries.get("kind")?.value?.value;
    if (entries.has("kind") && !kindLabels.includes(kind)) {
      error(
        file,
        `\`kind: ${JSON.stringify(kind)}\` is not a changie kind. Accepted kinds: ${kindLabels.join(", ")}.${didYouMean(kind, kindLabels)}`,
        at(entries.get("kind").value),
      );
    }

    const body = entries.get("body")?.value?.value;
    if (entries.has("body") && (typeof body !== "string" || body.trim() === "")) {
      error(file, "`body` must be a non-empty string.", at(entries.get("body").value));
    }

    // yaml's core schema leaves timestamps as strings; changie parses them with Go's yaml.v3,
    // which needs RFC 3339.
    const time = entries.get("time")?.value?.value;
    if (entries.has("time") && (typeof time !== "string" || Number.isNaN(Date.parse(time)))) {
      error(
        file,
        `\`time: ${JSON.stringify(time)}\` is not an RFC 3339 timestamp (e.g. 2026-07-30T12:00:00.000000000+02:00).`,
        at(entries.get("time").value),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// A changed module must carry a fragment.
//
// A bundled module publishes nothing to npm, so no changeset records that it
// changed and `version-packages` has no version move to key off. Its
// `metadata.version` moves only because someone wrote a fragment — and if nobody
// does, the change is invisible to the release and ships to nobody.
//
// This covers the half an author can see: a change under `modules/<name>/**`
// that can reach the published artifact. The other half — a shared library or a
// lockfile bump that alters a module's bundled bytes from outside its directory —
// is decided at publish time from the bytes themselves (`telo publish` compares
// each built layer's `integrity` against the published artifact), because no
// path-scoped rule can see it.
//
// "Can reach the artifact" is the whole question, and it is not the same as
// "is under the module directory": for a module that delivers no bundled
// controller, `nodejs/` is a pure npm package whose release ledger is changesets,
// and its contents never enter the artifact.
// ---------------------------------------------------------------------------

const baseRef = process.env.CHANGED_SINCE ?? "origin/main";

/** Per-language package directories inside a module. Whether their contents reach
 *  the published artifact depends on how the module delivers its controller. */
const LANGUAGE_DIRS = ["nodejs/", "rust/", "go/"];

/**
 * Does this module ship a bundled controller?
 *
 * If it does, its sources are the bundle's inputs and a change to them changes
 * what the artifact carries. If it does not, the language directory is a pure
 * npm/cargo package — the artifact is `telo.yaml` plus whatever `files:` selects,
 * and nothing under `nodejs/` is in it. Changesets governs that package; asking
 * for a changie fragment as well would bump `metadata.version` and republish an
 * artifact whose bytes did not move, which is exactly the spurious version churn
 * the publish-time digest gate exists to avoid.
 */
function bundlesAController(name) {
  try {
    return readFileSync(join(ROOT, "modules", name, "telo.yaml"), "utf8").includes(
      "pkg:telo/local/",
    );
  } catch {
    return false;
  }
}

let changedModules = new Set();
try {
  const diff = execSync(`git diff --name-only ${baseRef}...HEAD`, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  for (const file of diff.split("\n")) {
    const match = /^modules\/([^/]+)\/(.+)$/.exec(file.trim());
    if (!match) continue;
    const [, name, rest] = match;
    // A docs-only or plan-only edit changes nothing a consumer receives.
    if (rest.startsWith("docs/") || rest.startsWith("plans/") || rest === "README.md") continue;
    if (rest === "CHANGELOG.md") continue;
    if (LANGUAGE_DIRS.some((dir) => rest.startsWith(dir)) && !bundlesAController(name)) continue;
    changedModules.add(name);
  }
} catch {
  // No merge base (a shallow clone, a fresh repo) — the gate cannot decide what
  // changed, and guessing would fail PRs at random. The publish-time digest gate
  // still backstops it.
  changedModules = new Set();
}

/** `metadata.version` of a module's manifest at a git ref, or null when the file
 *  or the field is absent there. */
function manifestVersionAt(ref, name) {
  try {
    const text = execSync(`git show ${ref}:modules/${name}/telo.yaml`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDocument(text.split(/^---$/m)[0]).toJS()?.metadata?.version ?? null;
  } catch {
    return null;
  }
}

/** Whether this module's release is already accounted for: either its version
 *  moved on the branch (the fragment was written and then batched), or the module
 *  does not exist at the base ref at all — a new module has no published
 *  predecessor its change could fail to reach. */
function releaseAccountedFor(name) {
  const before = manifestVersionAt(baseRef, name);
  if (before === null) return true;
  const after = manifestVersionAt("HEAD", name);
  return after !== null && before !== after;
}

if (changedModules.size > 0) {
  const pending = new Set();
  if (existsSync(UNRELEASED)) {
    for (const file of readdirSync(UNRELEASED)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const parsed = parseDocument(readFileSync(join(UNRELEASED, file), "utf8")).toJS();
      if (parsed?.project) pending.add(parsed.project);
    }
  }
  for (const name of [...changedModules].sort()) {
    // Only modules changie actually versions; a directory with no project key has
    // no metadata.version to move.
    if (!projectKeys.includes(name)) continue;
    if (pending.has(name)) continue;
    // A version that already moved on this branch means the fragment was written
    // and then batched — the release happened, and requiring a second fragment
    // would make every long-lived branch fail for work it already accounted for.
    if (releaseAccountedFor(name)) continue;
    console.error(
      `::error::modules/${name} changed but no pending changie fragment declares \`project: ${name}\`. ` +
        `A bundled module publishes nothing to npm, so a fragment is the only thing that moves its ` +
        `metadata.version — without one the change ships to nobody. Add one with ` +
        `\`changie new --project ${name}\`.`,
    );
    failed = 1;
  }
}

if (failed === 0) console.log("check-changie-fragments: all pending fragments are valid.");
process.exit(failed);
