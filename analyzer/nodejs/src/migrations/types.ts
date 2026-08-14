/** Manifest migrations — the entry vocabulary.
 *
 *  A migration is a MATCHER plus a PATCH. The two halves are at different
 *  maturities and that is deliberate (`plans/manifest-migrations.md`):
 *
 *  - The **patch** names what it targets. Every operation has a known YAML edit
 *    form, which is what makes a migration applicable to a *file* at all and
 *    what lets the driver derive whether a quick fix exists — read straight off
 *    the verb, never declared by the author.
 *  - The **matcher** selects every occurrence of a legacy spelling, which is
 *    the half a plain patch format has none of (see `match.ts`).
 *
 *  BOTH halves are data, and an entry contains no code at all. That is what
 *  lets one entry file be read by every kernel: a predicate expressed in one
 *  language would mean one artifact is read two ways, invisibly, since a
 *  migration that succeeds is silent. A migration that does not fit is a signal
 *  to extend the vocabulary, never to hand-write a rewrite. */

import type { DiagnosticSeverity } from "../types.js";
import type { MigrationMatch } from "./match.js";

/** A location inside one manifest document. Segments are mapping keys
 *  (strings) and sequence indices (numbers) — the same shape `Document.getIn`
 *  takes, so the tree applier and the YAML applier address a node identically. */
export type MigrationPath = ReadonlyArray<string | number>;

/** Rename the matched mapping entry's KEY, within its own mapping. Deliberately
 *  not JSON Patch's `move`, which relocates a value anywhere in a document
 *  across parents and replaces an occupied destination. This refuses an
 *  occupied destination instead — silently discarding a value the author wrote
 *  is exactly what the leave-it-alone invariant exists to prevent. */
export interface RenameKeyOperation {
  readonly op: "rename-key";
  readonly to: string;
}

/** Replace the value at the matched location.
 *
 *  Exactly one of `value` / `qualify` is supplied. `qualify` prefixes the
 *  existing string — the shape a spelling rewrite that alias-qualifies a bare
 *  name needs, which a literal `value` cannot express because a patch is static
 *  data and cannot read the match. */
export interface SetValueOperation {
  readonly op: "set-value";
  readonly value?: unknown;
  readonly qualify?: string;
}

/** Put the matched scalar behind a templating tag (`!cel`, `!ref`, …). `tag` is
 *  the engine name without its `!`. */
export interface SetTagOperation {
  readonly op: "set-tag";
  readonly tag: string;
}

/** Insert an item into the matched sequence. `at` defaults to the end. */
export interface InsertItemOperation {
  readonly op: "insert-item";
  readonly value: unknown;
  readonly at?: number;
}

/** Remove the matched mapping entry or sequence item. */
export interface RemoveEntryOperation {
  readonly op: "remove-entry";
}

/** The closed operation vocabulary. Named for what each TARGETS, so the target
 *  is never inferred from which parameter happens to be present and the
 *  quick-fix question reads off the name. */
export type MigrationOperation =
  | RenameKeyOperation
  | SetValueOperation
  | SetTagOperation
  | InsertItemOperation
  | RemoveEntryOperation;

export const MIGRATION_OPS = [
  "rename-key",
  "set-value",
  "set-tag",
  "insert-item",
  "remove-entry",
] as const;

/** One legacy spelling and the edit that replaces it. */
export interface MigrationRule {
  /** Which nodes this rule rewrites, resolved against the frozen pre-migration
   *  tree. Declarative — see `match.ts`. */
  readonly match: MigrationMatch;
  /** Applied in order at each match. A patch that cannot apply in full leaves
   *  the node untouched. */
  readonly patch: readonly MigrationOperation[];
}

/** One deprecation story. May carry several rules — the value-type unification
 *  changed three spellings but tells the author one thing, which is why the
 *  rationale is entry-level and a mechanical description is not. */
export interface MigrationEntry {
  /** Stable identifier. Names which migration fired; docs list them. */
  readonly id: string;
  /** Diagnostic code reported for every rewrite this entry makes. */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  /** A sentence or two of rationale — the one part the driver cannot generate,
   *  and the part that makes a deprecation actionable rather than mysterious.
   *  Never a clause of the generated sentence. */
  readonly reason: string;
  readonly rules: readonly MigrationRule[];
}

/** One applied rewrite. Path provenance is part of the driver's contract:
 *  diagnostics are remapped through `legacyPath` before position resolution,
 *  and `telo migrate` reads its edit target from the same record — the location
 *  in the author's file, not the post-rewrite path. */
export interface MigrationRewrite {
  readonly entryId: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly documentIndex: number;
  /** Dotted path (`a.b[0].c`) as the AUTHOR wrote it — the key into a
   *  position index built from the raw file. */
  readonly legacyPath: string;
  /** Dotted path after the rewrite. Equal to `legacyPath` unless a
   *  `rename-key` moved it. */
  readonly migratedPath: string;
  /** Human-readable description of what changed, generated by the driver. */
  readonly summary: string;
}

/** Why a matched patch was refused. A migration that cannot rewrite leaves the
 *  node untouched for the ordinary validator to reject — never guessing, never
 *  dropping. */
export type MigrationRefusal =
  | "path-not-found"
  | "destination-occupied"
  | "not-a-mapping-entry"
  | "not-a-sequence"
  | "not-a-scalar"
  | "malformed-value"
  /** The value is already what the patch would write. A rule should match only
   *  the legacy spelling, so this means its matcher was too wide — refusing
   *  keeps that from surfacing as a deprecation the author cannot act on. */
  | "nothing-to-rewrite";
