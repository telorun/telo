import { createHash } from "node:crypto";
import type { DeclaredTable, SchemaObjectId } from "./declared-schema.js";
import { objectKey } from "./declared-schema.js";

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

export function snapshotDeclaration(tables: readonly DeclaredTable[]): DeclarationSnapshot {
  const snapshot: DeclarationSnapshot = {};
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

export function parseObjectKey(key: string): SchemaObjectId {
  const [kind, rest] = key.split(":", 2) as [SchemaObjectId["kind"], string];
  const dot = rest.indexOf(".");
  if (kind === "table" || dot < 0) return { kind, table: rest };
  return { kind, table: rest.slice(0, dot), name: rest.slice(dot + 1) };
}
