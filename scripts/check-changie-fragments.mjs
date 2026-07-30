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
// Usage: node scripts/check-changie-fragments.mjs

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

if (failed === 0) console.log("check-changie-fragments: all pending fragments are valid.");
process.exit(failed);
