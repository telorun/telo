/** The on-disk shape of a migration entry, and its reader.
 *
 *  An entry is DATA: one file per entry under `analyzer/migrations/`, consumed
 *  as one lexically ordered set. That is what makes adding a migration one file
 *  and retiring one deleting it, what ships the set in the published package,
 *  and what lets the Rust crate embed the identical files at build time rather
 *  than reimplementing each rewrite.
 *
 *  **An entry contains no code.** Both halves — what a rule matches and what it
 *  patches — are data, so one file is read identically by every kernel. A
 *  predicate expressed in one language would mean one artifact is read two
 *  ways, invisibly, since a migration that succeeds is silent.
 *
 *  Reading is STRICT. A malformed entry is an authoring mistake, and the
 *  alternative to throwing is a migration that silently does not run — the one
 *  failure mode a rewrite-on-load design cannot afford, because a migration
 *  that succeeds and one that never fires look identical. */

import { DiagnosticSeverity } from "../types.js";
import { readMigrationMatch } from "./match.js";
import type {
  MigrationEntry,
  MigrationOperation,
  MigrationRule,
} from "./types.js";
import { MIGRATION_OPS } from "./types.js";

/** How an entry file names a severity. The LSP integers are a transport detail
 *  of one editor; an entry is read by a Rust crate too. */
const SEVERITIES: Record<string, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

class MigrationEntryError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid migration entry '${file}': ${detail}`);
    this.name = "MigrationEntryError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(file: string, node: Record<string, unknown>, key: string): string {
  const value = node[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationEntryError(file, `'${key}' must be a non-empty string`);
  }
  return value;
}

const OPERATION_KEYS: Record<(typeof MIGRATION_OPS)[number], readonly string[]> = {
  "rename-key": ["to"],
  "set-value": ["value", "qualify"],
  "set-tag": ["tag"],
  "insert-item": ["value", "at"],
  "remove-entry": [],
};

/** Top-level entry keys. `$comment` is the sanctioned place for author notes —
 *  the reader ignores it, but it has to be DECLARED, or "unknown keys are
 *  refused" would be true of every level but this one. */
const ENTRY_KEYS = ["id", "code", "severity", "reason", "rules", "$comment"] as const;

/**
 * A value a patch may write.
 *
 * Scalars only, because "every operation has a known YAML edit form" is what
 * makes a migration applicable to a FILE, and the file applier renders a value
 * by re-quoting it in the author's own style at the node's own span — which has
 * no meaning for a mapping or a sequence. Without this check the limitation is
 * invisible until a user runs `telo migrate` and is told, permanently, to fix
 * it by hand; with it, the entry's author learns at authoring time. Structured
 * values are a vocabulary extension (a block renderer), not a silent gap.
 */
function requireScalarValue(file: string, index: number, op: string, value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  throw new MigrationEntryError(
    file,
    `patch[${index}] ('${op}') value must be a scalar (string, number, boolean or null) — ` +
      `a mapping or sequence has no in-place YAML edit form, so \`telo migrate\` could never apply it`,
  );
}

function readOperation(file: string, raw: unknown, index: number): MigrationOperation {
  if (!isPlainObject(raw)) {
    throw new MigrationEntryError(file, `patch[${index}] must be a mapping`);
  }
  const op = raw.op;
  if (typeof op !== "string" || !(MIGRATION_OPS as readonly string[]).includes(op)) {
    throw new MigrationEntryError(
      file,
      `patch[${index}].op '${String(op)}' is not one of ${MIGRATION_OPS.join(", ")}`,
    );
  }
  // The vocabulary is closed, so an unknown parameter is a typo — and a typo in
  // a patch is a rewrite that quietly does something other than what it reads
  // as. `set-value`'s two parameters are alternatives, checked below.
  const allowed = new Set<string>([...OPERATION_KEYS[op as (typeof MIGRATION_OPS)[number]], "op"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new MigrationEntryError(file, `patch[${index}] ('${op}') has no parameter '${key}'`);
    }
  }

  switch (op) {
    case "rename-key":
      return { op, to: requireString(file, raw, "to") };
    case "set-value": {
      const hasValue = Object.hasOwn(raw, "value");
      const hasQualify = Object.hasOwn(raw, "qualify");
      if (hasValue === hasQualify) {
        throw new MigrationEntryError(
          file,
          `patch[${index}] ('set-value') takes exactly one of 'value' or 'qualify'`,
        );
      }
      if (hasQualify) return { op, qualify: requireString(file, raw, "qualify") };
      requireScalarValue(file, index, op, raw.value);
      return { op, value: raw.value };
    }
    case "set-tag":
      return { op, tag: requireString(file, raw, "tag") };
    case "insert-item": {
      if (!Object.hasOwn(raw, "value")) {
        throw new MigrationEntryError(file, `patch[${index}] ('insert-item') requires 'value'`);
      }
      requireScalarValue(file, index, op, raw.value);
      const at = raw.at;
      if (at !== undefined && (typeof at !== "number" || !Number.isInteger(at) || at < 0)) {
        throw new MigrationEntryError(
          file,
          `patch[${index}].at must be a non-negative integer when present`,
        );
      }
      return at === undefined ? { op, value: raw.value } : { op, value: raw.value, at };
    }
    case "remove-entry":
      return { op };
    default:
      throw new MigrationEntryError(file, `patch[${index}].op '${op}' is unhandled`);
  }
}

function readRule(file: string, raw: unknown, index: number): MigrationRule {
  if (!isPlainObject(raw)) {
    throw new MigrationEntryError(file, `rules[${index}] must be a mapping`);
  }
  if (!Array.isArray(raw.patch) || raw.patch.length === 0) {
    throw new MigrationEntryError(file, `rules[${index}].patch must be a non-empty sequence`);
  }
  return {
    match: readMigrationMatch(`Invalid migration entry '${file}': rules[${index}]`, raw.match),
    patch: raw.patch.map((op, i) => readOperation(file, op, i)),
  };
}

/**
 * Read one entry file's parsed data into a `MigrationEntry`.
 *
 * `file` names the entry file, so a failure says which one.
 */
export function parseMigrationEntry(file: string, data: unknown): MigrationEntry {
  if (!isPlainObject(data)) {
    throw new MigrationEntryError(file, "an entry must be a mapping");
  }
  // Closed at every level, this one included: a typo'd top-level key would
  // otherwise be silently ignored, which is the one failure a rewrite-on-load
  // design cannot afford once module-shipped entries make this a trust boundary.
  for (const key of Object.keys(data)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new MigrationEntryError(
        file,
        `an entry has no key '${key}'. Known keys: ${ENTRY_KEYS.join(", ")}.`,
      );
    }
  }
  const severityName = requireString(file, data, "severity");
  const severity = SEVERITIES[severityName];
  if (severity === undefined) {
    throw new MigrationEntryError(
      file,
      `severity '${severityName}' must be one of ${Object.keys(SEVERITIES).join(", ")}`,
    );
  }
  if (!Array.isArray(data.rules) || data.rules.length === 0) {
    throw new MigrationEntryError(file, "'rules' must be a non-empty sequence");
  }
  return {
    id: requireString(file, data, "id"),
    code: requireString(file, data, "code"),
    severity,
    reason: requireString(file, data, "reason").trim(),
    rules: data.rules.map((rule, i) => readRule(file, rule, i)),
  };
}
