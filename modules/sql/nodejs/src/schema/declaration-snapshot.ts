import { createHash } from "node:crypto";
import type { DeclaredEnum, DeclaredTable, SchemaObjectId } from "./declared-schema.js";
import { objectKey, TABLE_CHILD_KINDS } from "./declared-schema.js";
import { seedRowId, seedRowKey } from "./seed-rows.js";

/**
 * The declaration, flattened to one entry per schema object.
 *
 * Recording the snapshot rather than only its digest is what answers the
 * question reconciliation cannot answer from live state alone: which objects
 * THIS schema resource owns. An object in the namespace that has never appeared
 * in a snapshot was never declared here — a legacy table, another application's,
 * one predating adoption — and is invisible to both the diff and reclamation.
 * Inferring ownership from presence would make adopting an existing database a
 * data-loss event.
 *
 * It also supplies a tombstone's last-known definition for free, so nothing has
 * to reconstruct what a dropped object was after the declaration stopped
 * describing it.
 */
export type DeclarationSnapshot = Record<string, string>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function entry(snapshot: DeclarationSnapshot, id: SchemaObjectId, definition: unknown): void {
  snapshot[objectKey(id)] = JSON.stringify(stable(definition));
}

export function snapshotDeclaration(
  tables: readonly DeclaredTable[],
  enums: readonly DeclaredEnum[] = [],
  extensions: readonly string[] = [],
): DeclarationSnapshot {
  const snapshot: DeclarationSnapshot = {};
  for (const name of extensions) {
    entry(snapshot, { kind: "extension", table: name }, { name });
  }
  // The WHOLE enum declaration, not just its name: on an engine with no named
  // types nothing in the database corresponds to it, so the recorded declaration
  // is the only thing a change can be detected against.
  for (const declared of enums) {
    entry(snapshot, { kind: "enum", table: declared.typeName }, declared);
  }
  for (const table of tables) {
    entry(snapshot, { kind: "table", table: table.name }, { name: table.name });
    for (const column of table.columns) {
      entry(snapshot, { kind: "column", table: table.name, name: column.name }, column);
    }
    for (const index of table.indexes) {
      entry(snapshot, { kind: "index", table: table.name, name: index.name }, index);
    }
    for (const fk of table.foreignKeys) {
      entry(snapshot, { kind: "foreignKey", table: table.name, name: fk.name }, fk);
    }
    for (const check of table.checks) {
      entry(snapshot, { kind: "check", table: table.name, name: check.name }, check);
    }
    // The WHOLE row, because reclaiming one means deleting it by key and the key
    // values are the only way back to it once the declaration has stopped saying
    // so. A `when:` that evaluates false records none, which is what withdraws
    // the declaration.
    if (table.seeds?.when) {
      for (const row of table.seeds.rows) {
        entry(snapshot, seedRowId(table.name, seedRowKey(table.seeds, row)), row);
      }
    }
  }
  return snapshot;
}

/** Stable digest of a snapshot — what the ledger compares boots against. */
export function snapshotDigest(snapshot: DeclarationSnapshot): string {
  const canonical = JSON.stringify(
    Object.keys(snapshot)
      .sort()
      .map((key) => [key, snapshot[key]]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The inverse of `objectKey`, exactly — `objectKey(parseObjectKey(k)) === k` for
 * every key this design writes.
 *
 * Split at the FIRST separator of each kind, never with `String.split`'s limit:
 * `split(":", 2)` returns the first two fields and DISCARDS the rest, so a seed
 * row keyed on an ISO timestamp (`seedRow:events.at="2024-01-01T00:00:00Z"`)
 * came back as `at="2024-01-01T00` — a name that names nothing, reported in
 * every reclamation message and, worse, a key that no longer round-trips through
 * the rename rewrite.
 */
export function parseObjectKey(key: string): SchemaObjectId {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon) as SchemaObjectId["kind"];
  const rest = key.slice(colon + 1);
  const dot = rest.indexOf(".");
  // A top-level object carries its own physical name in `table` and has no
  // `name`, so a dot inside it is part of that name rather than a separator.
  if (dot < 0 || !TABLE_CHILD_KINDS.has(kind)) return { kind, table: rest };
  return { kind, table: rest.slice(0, dot), name: rest.slice(dot + 1) };
}
