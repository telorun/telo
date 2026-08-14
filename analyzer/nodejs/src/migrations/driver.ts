/** The migration driver — one pass, one set of guarantees.
 *
 *  **Composition is the driver's guarantee, not each entry's proof
 *  obligation.** The match set is frozen against the pre-migration tree, so no
 *  rule can match a node another rule produced; rules within an entry apply in
 *  order at each match; entries never see one another's output. That matters
 *  once core and module entries are aggregated from different parties, where
 *  "it happens to work" is not determinism. Idempotency then follows from the
 *  driver rather than from every author getting it right: a rule matches only
 *  the legacy spelling, and re-running finds nothing.
 *
 *  How a rewrite is REPORTED — the provenance record and the diagnostic — is
 *  `report.ts`. Nothing there can change what a migration does, and nothing
 *  here decides how it reads. */

import type { ResourceManifest } from "@telorun/sdk";
import type { Document } from "yaml";
import {
  applyEffectsToTree,
  formatMigrationPath,
  planPatch,
  type MigrationEffect,
} from "./patch.js";
import { applyTextEdits, planTextEdits, type TextEdit } from "./yaml-edit.js";
import { applicableRules, buildMatchIndex, selectMatches } from "./match.js";
import { CORE_MIGRATIONS } from "./registry.js";
import { toDiagnostic, toRewrite, type AppliedPatch } from "./report.js";
import type {
  MigrationEntry,
  MigrationOperation,
  MigrationPath,
  MigrationRewrite,
} from "./types.js";
import type { AnalysisDiagnostic } from "../types.js";

/** What one file's migration produced. */
export interface FileMigrations {
  /** One record per applied rewrite, in application order. Empty when the file
   *  carried no legacy spelling — the overwhelmingly common case. */
  readonly rewrites: readonly MigrationRewrite[];
  /** One diagnostic per rewrite. Whether they are SURFACED is the graph's
   *  decision: a migration rewrites always, because the runtime must read
   *  artifacts published years ago, but reports only for the entry's own
   *  modules, because a published dependency is not the consumer's to fix. */
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

export const NO_MIGRATIONS: FileMigrations = { rewrites: [], diagnostics: [] };

/**
 * Run `entries` over one file's parsed documents, mutating `manifests` in
 * place. Returns the provenance records and their diagnostics.
 *
 * The manifests are the loader's own projection of the file, never the
 * author's text — nothing here can reach disk.
 */
export function migrateManifests(args: {
  source: string;
  manifests: Array<ResourceManifest | null>;
  entries?: readonly MigrationEntry[];
}): FileMigrations {
  const entries = args.entries ?? CORE_MIGRATIONS;
  if (entries.length === 0) return NO_MIGRATIONS;

  const applied = applyAll(args.manifests, entries);
  if (applied.length === 0) return NO_MIGRATIONS;

  const rewrites = applied.map((a) => toRewrite(a));
  const diagnostics = applied.map((a, i) =>
    toDiagnostic(a, rewrites[i]!, args.source, args.manifests),
  );
  return { rewrites, diagnostics };
}

/**
 * Migrate the author's YAML instead of the loader's tree — the operation
 * `telo migrate` is the reference application of.
 *
 * `manifests` must be the RAW (un-migrated) projection of `documents`, since
 * the matchers select legacy spellings. Returns `null` when nothing matched, so
 * a caller can leave an untouched file untouched rather than rewriting
 * identical bytes.
 *
 * `unwritable` names every rewrite the tree accepted but the TEXT could not
 * express. The two appliers can disagree only in this direction, and the
 * disagreement has to be reported: the diagnostic that sent the author here
 * says "run `telo migrate`", so a location this silently skipped would keep
 * warning with no way to act on it.
 */
export function migrateFileText(args: {
  source: string;
  text: string;
  documents: readonly Document[];
  manifests: ReadonlyArray<ResourceManifest | null>;
  entries?: readonly MigrationEntry[];
}): {
  text: string;
  rewrites: MigrationRewrite[];
  unwritable: MigrationRewrite[];
} | null {
  const entries = args.entries ?? CORE_MIGRATIONS;
  if (entries.length === 0) return null;

  // Planned against a copy: the tree walk is what decides which patches apply
  // (and in what order they refuse), so the YAML side must ask exactly the same
  // question of exactly the same state rather than re-deriving it.
  const scratch = args.manifests.map((m) => (m ? (structuredClone(m) as ResourceManifest) : null));
  const applied = applyAll(scratch, entries);
  if (applied.length === 0) return null;

  const edits: TextEdit[] = [];
  const kept: AppliedPatch[] = [];
  const skipped: AppliedPatch[] = [];
  for (const patch of applied) {
    const doc = args.documents[patch.documentIndex];
    if (!doc) {
      skipped.push(patch);
      continue;
    }
    const planned = planTextEdits(doc, args.text, patch.plan.effects);
    // A patch the tree accepted but the text cannot express (a block scalar
    // span, a flow-style entry) leaves that node alone rather than half-written.
    if (!planned) {
      skipped.push(patch);
      continue;
    }
    // Two patches whose spans overlap cannot both be spliced — the second would
    // write into bytes the first replaced. The tree side has no equivalent,
    // because an object write is idempotent where a splice is positional, so
    // this is the one place the file applier is stricter: the later patch is
    // dropped and its node stays as the author wrote it.
    if (planned.some((edit) => edits.some((existing) => overlaps(edit, existing)))) {
      skipped.push(patch);
      continue;
    }
    edits.push(...planned);
    kept.push(patch);
  }
  if (edits.length === 0 && skipped.length === 0) return null;

  return {
    text: edits.length > 0 ? applyTextEdits(args.text, edits) : args.text,
    rewrites: kept.map(toRewrite),
    unwritable: skipped.map(toRewrite),
  };
}

/** Whether two splices contend for the same bytes. A pure insertion (an empty
 *  span) collides only with a span that strictly contains its point. */
function overlaps(a: TextEdit, b: TextEdit): boolean {
  if (a.start === a.end) return b.start < a.start && a.start < b.end;
  if (b.start === b.end) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** One pass: every match collected against the frozen pre-migration tree, then
 *  applied in entry order. */
function applyAll(
  manifests: Array<ResourceManifest | null>,
  entries: readonly MigrationEntry[],
): AppliedPatch[] {
  const candidates: Array<{
    entry: MigrationEntry;
    ops: readonly MigrationOperation[];
    documentIndex: number;
    path: MigrationPath;
  }> = [];

  // One index per DOCUMENT, shared by every rule that can reach it — the walk
  // is the expensive part and does not depend on the rule. This runs on the
  // kernel's boot path for every file in the graph, so a walk per rule would
  // scale the cost of loading any manifest with the size of the migration set.
  //
  // The `inKind` gate and the `under` regions are both known BEFORE the walk,
  // so they bound it rather than filtering its output: a document no rule
  // targets is never walked, and a region no rule names is never descended
  // into. `type:` alone occurs a couple of hundred times in a standard-library
  // manifest, so indexing sites that cannot be selected is the whole cost.
  const flatRules = entries.flatMap((entry) =>
    entry.rules.map((rule) => ({ entry, ops: rule.patch, match: rule.match })),
  );
  for (let documentIndex = 0; documentIndex < manifests.length; documentIndex++) {
    const manifest = manifests[documentIndex];
    if (!manifest) continue;
    const { rules, keys, roots } = applicableRules(flatRules, manifest.kind);
    if (rules.length === 0) continue;
    const index = buildMatchIndex(manifest, keys, roots);
    for (const { entry, ops, match } of rules) {
      for (const path of selectMatches(index, manifest, match)) {
        candidates.push({ entry, ops, documentIndex, path });
      }
    }
  }

  // Arrays whose LENGTH an already-applied patch changed, as
  // `<documentIndex>:<dotted path>`. A frozen match names a sequence element by
  // INDEX, and an index is not an identity: once a sibling patch inserted or
  // removed an item, the same index names a different element — including one
  // another rule just produced, which is exactly what the frozen match set
  // exists to prevent. A key-based path needs no such record, because a rename
  // or removal makes the stale path resolve to nothing and `planPatch` refuses
  // it on its own.
  const shiftedArrays = new Set<string>();

  const applied: AppliedPatch[] = [];
  for (const candidate of candidates) {
    const manifest = manifests[candidate.documentIndex];
    if (!manifest) continue;
    if (indexIsStale(candidate.documentIndex, candidate.path, shiftedArrays)) continue;
    const result = planPatch(manifest, candidate.path, candidate.ops);
    // Refusal is not an error: the node stays as the author wrote it and the
    // ordinary validator reports it with an accurate message.
    if (!result.ok) continue;
    applyEffectsToTree(manifest, result.plan.effects);
    for (const array of resizedArrays(candidate.documentIndex, result.plan.effects)) {
      shiftedArrays.add(array);
    }
    applied.push({
      entry: candidate.entry,
      documentIndex: candidate.documentIndex,
      matched: candidate.path,
      plan: result.plan,
      ops: candidate.ops,
    });
  }
  return applied;
}

/** Arrays this patch resized, keyed for `shiftedArrays`. */
function resizedArrays(
  documentIndex: number,
  effects: readonly MigrationEffect[],
): string[] {
  const out: string[] = [];
  for (const effect of effects) {
    if (effect.kind === "insert-item") {
      out.push(`${documentIndex}:${formatMigrationPath(effect.path)}`);
    } else if (
      effect.kind === "remove-entry" &&
      typeof effect.path[effect.path.length - 1] === "number"
    ) {
      out.push(`${documentIndex}:${formatMigrationPath(effect.path.slice(0, -1))}`);
    }
  }
  return out;
}

/** Whether any index along `path` steps into an array a prior patch resized. */
function indexIsStale(
  documentIndex: number,
  path: MigrationPath,
  shiftedArrays: ReadonlySet<string>,
): boolean {
  if (shiftedArrays.size === 0) return false;
  for (let i = 0; i < path.length; i++) {
    if (typeof path[i] !== "number") continue;
    if (shiftedArrays.has(`${documentIndex}:${formatMigrationPath(path.slice(0, i))}`)) {
      return true;
    }
  }
  return false;
}
