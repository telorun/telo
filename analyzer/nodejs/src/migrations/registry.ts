/** The core migration set — entries that ship with the analyzer and may match
 *  any node.
 *
 *  **The set is data, not code.** One JSON file per entry, canonical at
 *  `analyzer/migrations/`, read as one lexically ordered list: adding a
 *  migration is one file, and retiring one is deleting it. Nothing here lists
 *  the entries — TypeScript has no glob import, so the barrel beside the copies
 *  is emitted from the same directory listing that produced them. A
 *  hand-maintained list was the one place this mechanism could fail silently:
 *  add a file, forget the import, and the migration never fires, which looks
 *  exactly like one that ran.
 *
 *  The files live beside the language implementations rather than inside any
 *  one of them because every kernel must apply the IDENTICAL rewrite — a
 *  rewrite added to one side would mean one artifact means two things on two
 *  kernels, invisibly, since a migration that succeeds is silent. Only
 *  `analyzer/nodejs` reads them today — the Rust reader is planned, and until
 *  it lands the Rust kernel applies NO migration, so a legacy spelling it
 *  cannot otherwise interpret fails there rather than being rewritten. When it
 *  lands it will embed these files with `include_str!`; a Go half would use
 *  `//go:embed`. JSON rather than YAML for one reason: it is the only format
 *  all three embed with no generation step, because TypeScript's only native
 *  embed is `resolveJsonModule`. The copy under `./entries/` is made by the
 *  analyzer's `prepare` (`scripts/copy-migration-entries.mjs`) — identical
 *  bytes, so no entry's MEANING is ever derived from anything.
 *
 *  **Entries carry no version stamp.** "Can this be deleted?" turns on whether
 *  any published artifact still carries the legacy spelling, which the
 *  artifact's own release version cannot answer — the hub can, since it caches
 *  every tracked module version's `telo.yaml`. A stamp would record when an
 *  entry was written, which git already does, while looking like an answer to a
 *  question it does not address. */

import { parseMigrationEntry } from "./entry-data.js";
import { MIGRATION_ENTRY_FILES } from "./entries/index.js";
import type { MigrationEntry } from "./types.js";

export const CORE_MIGRATIONS: readonly MigrationEntry[] = MIGRATION_ENTRY_FILES.map(
  ([file, data]) => parseMigrationEntry(file, data),
);
