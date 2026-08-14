/** How a rewrite is REPORTED — the provenance record and the diagnostic.
 *
 *  Split from the driver because the two answer different questions: the driver
 *  owns the guarantees (one pass, a frozen match set, all-or-nothing patches,
 *  refusal rather than a guess), while everything here is about telling an
 *  author what happened. Nothing in this file can change what a migration does.
 *
 *  **A diagnostic composes in three parts and the entry writes only one.** What
 *  changed and how to apply it are generated identically for every entry, from
 *  the matched key and value, the replacement, and the operation verbs. What
 *  the driver cannot know is *why*, which is the part that makes a deprecation
 *  actionable rather than mysterious — so an entry supplies `reason`, and never
 *  a clause of the generated sentence. */

import type { ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { formatMigrationPath, type MigrationEffect, type PatchPlan } from "./patch.js";
import type {
  MigrationEntry,
  MigrationOperation,
  MigrationPath,
  MigrationRewrite,
} from "./types.js";
import type { AnalysisDiagnostic, DiagnosticFix } from "../types.js";

/** One patch that applied, as the reporting side needs to see it. */
export interface AppliedPatch {
  readonly entry: MigrationEntry;
  readonly documentIndex: number;
  readonly matched: MigrationPath;
  readonly plan: PatchPlan;
  readonly ops: readonly MigrationOperation[];
}

export function toRewrite(applied: AppliedPatch): MigrationRewrite {
  return {
    entryId: applied.entry.id,
    code: applied.entry.code,
    severity: applied.entry.severity,
    documentIndex: applied.documentIndex,
    legacyPath: formatMigrationPath(applied.matched),
    migratedPath: formatMigrationPath(applied.plan.finalPath),
    summary: describeChange(applied),
  };
}

export function toDiagnostic(
  applied: AppliedPatch,
  rewrite: MigrationRewrite,
  source: string,
  manifests: ReadonlyArray<ResourceManifest | null>,
): AnalysisDiagnostic {
  const fix = deriveFix(applied);
  const closing = fix
    ? "Run `telo migrate` to apply it."
    : `no quick fix (${refusalPhrase(applied.ops)}) — run \`telo migrate\``;

  const manifest = manifests[applied.documentIndex];
  const kind = manifest?.kind;
  const name = manifest?.metadata?.name;

  return {
    severity: applied.entry.severity,
    code: applied.entry.code,
    source: "telo-analyzer",
    message: `${rewrite.summary}\n${applied.entry.reason}\n${closing}`,
    data: {
      filePath: source,
      // The AUTHOR's path, not the post-rewrite one: the position index is
      // built from the raw file and knows only the spelling that is in it.
      path: rewrite.legacyPath,
      ...(typeof kind === "string" && typeof name === "string"
        ? { resource: { kind, name } }
        : {}),
      ...(fix ? { fix } : {}),
      migration: {
        id: applied.entry.id,
        legacyPath: rewrite.legacyPath,
        migratedPath: rewrite.migratedPath,
      },
    },
  };
}

/**
 * Whether a quick fix exists is DERIVED from the operations, never declared.
 *
 * `DiagnosticFix` is a whole-value `replacement` written over a value node's
 * span, and it promises a repair applicable without review. A lone `set-value`
 * producing a scalar is exactly that. Anything else — a key rename, a tag, a
 * collection edit, a structured value — has no honest whole-value form, and the
 * diagnostic says so rather than offering a repair that would corrupt the file.
 * The derivation is total, so a migration never silently lacks one.
 */
function deriveFix(applied: AppliedPatch): DiagnosticFix | undefined {
  if (applied.ops.length !== 1) return undefined;
  const only = applied.ops[0]!;
  if (only.op !== "set-value") return undefined;
  const value = applied.plan.after;
  if (typeof value === "string") return { replacement: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { replacement: String(value) };
  }
  return undefined;
}

function refusalPhrase(ops: readonly MigrationOperation[]): string {
  for (const op of ops) {
    switch (op.op) {
      case "rename-key":
        return "renames a key";
      case "set-tag":
        return "adds a tag";
      case "insert-item":
        return "inserts an item";
      case "remove-entry":
        return "removes an entry";
      default:
        break;
    }
  }
  return "writes a structured value";
}

/** Only the items an `insert-item` added, narrowed by the effect's own kind so
 *  the value is read off a typed field rather than cast out of a union. */
function insertedValues(effects: readonly MigrationEffect[]): unknown[] | undefined {
  const values: unknown[] = [];
  for (const effect of effects) {
    if (effect.kind !== "insert-item") return undefined;
    values.push(effect.value);
  }
  return values.length > 0 ? values : undefined;
}

/** The generated "what changed" sentence — the half no entry writes. */
function describeChange(applied: AppliedPatch): string {
  const legacyKey = lastSegment(applied.matched);
  const migratedKey = lastSegment(applied.plan.finalPath);
  const { before, after, effects } = applied.plan;

  if (after === undefined && effects.some((e) => e.kind === "remove-entry")) {
    return `\`${legacyKey}\` is no longer used.`;
  }
  const inserted = insertedValues(effects);
  if (inserted) {
    return `\`${formatMigrationPath(applied.matched)}\` gains \`${inserted
      .map(renderValue)
      .join("`, `")}\`.`;
  }
  return `\`${legacyKey}: ${renderValue(before)}\` is now written \`${migratedKey}: ${renderValue(after)}\`.`;
}

function lastSegment(path: MigrationPath): string {
  const last = path[path.length - 1];
  return typeof last === "number" ? `[${last}]` : String(last ?? "");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isTaggedSentinel(value)) return `!${value.engine} ${value.source}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
