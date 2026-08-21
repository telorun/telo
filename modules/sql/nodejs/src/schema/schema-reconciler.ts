import type {
  DeclaredColumn,
  DeclaredForeignKey,
  DeclaredIndex,
  DeclaredTable,
  SchemaObjectId,
} from "./declared-schema.js";
import { objectKey } from "./declared-schema.js";
import type { DeclarationSnapshot } from "./declaration-snapshot.js";
import { parseObjectKey } from "./declaration-snapshot.js";
import type {
  LiveColumn,
  LiveForeignKey,
  LiveIndex,
  LiveTable,
  SchemaDriver,
} from "./schema-driver.js";

/**
 * The diff. One global pass over the declaration: the manifest holds only
 * current declared state, so there is exactly one reconciliation target and no
 * historical state to replay towards.
 *
 * Nothing here executes. A plan is built, refusals are collected, and the
 * runner decides — which is what lets an unsafe change stop the release before
 * any DDL has run rather than half way through it.
 */

/** DDL ordering. Cross-table constraints come last so declaration order is
 *  never load-bearing and foreign-key ordering is never the author's problem. */
export type PlanPhase = "table" | "index" | "constraint";

export interface PlannedStatement {
  readonly phase: PlanPhase;
  readonly sql: string;
  readonly describes: string;
}

export interface PlannedTombstone {
  readonly id: SchemaObjectId;
  readonly key: string;
  readonly definition: string;
}

export interface Refusal {
  readonly object: string;
  readonly reason: string;
}

export interface SchemaPlan {
  readonly statements: readonly PlannedStatement[];
  readonly tombstones: readonly PlannedTombstone[];
  /** Tombstoned objects the declaration has brought back. */
  readonly revived: readonly string[];
  /**
   * `renamedFrom:` mentions that can no longer do anything — the source column
   * is neither present nor tombstoned, so there is nothing left to copy and
   * nothing left to hold. The rename is finished; the mention is now dead
   * manifest text, and saying so is the only way the author learns it can go.
   */
  readonly inertRenames: readonly string[];
  readonly refusals: readonly Refusal[];
}

/**
 * Whether a live column still matches its declaration. Comparison is over the
 * driver's own canonical type signature, nullability and the presence of a
 * default — every type rule stays inside the driver, and nothing here parses a
 * type.
 */
function columnDiffers(driver: SchemaDriver, live: LiveColumn, declared: DeclaredColumn): boolean {
  const declaresDefault =
    declared.default !== undefined || declared.defaultExpression !== undefined;
  return (
    live.typeSignature !== driver.typeSignature(declared) ||
    live.nullable !== declared.nullable ||
    live.hasDefault !== declaresDefault ||
    // Uniqueness and key membership are what the declaration PROMISES about the
    // data. Compared by nothing at all, adding `unique: true` to a live column
    // emitted no DDL and no report while the ledger recorded it as owned — so
    // the manifest asserted a constraint the database was not enforcing.
    live.primaryKey !== declared.primaryKey ||
    live.unique !== declared.unique
  );
}

/** Column order is part of an index: `(a, b)` and `(b, a)` are different indexes. */
function indexDiffers(live: LiveIndex, declared: DeclaredIndex): boolean {
  return (
    live.unique !== declared.unique ||
    live.columns.length !== declared.columns.length ||
    live.columns.some((column, i) => column !== declared.columns[i])
  );
}

/** A referential action is what the constraint DOES, so a change to it is a
 *  change to the constraint. An action the engine did not report is not compared
 *  — an absent reading is not evidence of a difference. */
/**
 * The columns a key maps to what, which is what makes it THAT key rather than
 * another. Its referential actions are settable properties of it, deliberately
 * excluded: an engine that keeps no name matches on this, and folding the
 * actions in would make a changed delete rule read as a brand new key — an ADD
 * where the author should have been told the rule cannot be changed in place.
 */
function sameForeignKeyIdentity(live: LiveForeignKey, declared: DeclaredForeignKey): boolean {
  return (
    live.references.table === declared.references.table &&
    live.columns.length === declared.columns.length &&
    live.columns.every((column, i) => column === declared.columns[i]) &&
    live.references.columns.length === declared.references.columns.length &&
    live.references.columns.every((column, i) => column === declared.references.columns[i])
  );
}

function foreignKeyDiffers(live: LiveForeignKey, declared: DeclaredForeignKey): boolean {
  const action = (value: string | undefined): string | undefined => value?.toUpperCase();
  return (
    live.references.table !== declared.references.table ||
    live.columns.length !== declared.columns.length ||
    live.columns.some((column, i) => column !== declared.columns[i]) ||
    live.references.columns.length !== declared.references.columns.length ||
    live.references.columns.some((column, i) => column !== declared.references.columns[i]) ||
    (live.onDelete !== undefined && action(live.onDelete) !== (action(declared.onDelete) ?? "NO ACTION")) ||
    (live.onUpdate !== undefined && action(live.onUpdate) !== (action(declared.onUpdate) ?? "NO ACTION"))
  );
}

function liveByName(live: readonly LiveTable[]): Map<string, LiveTable> {
  return new Map(live.map((table) => [table.name, table]));
}

export function planReconciliation(
  driver: SchemaDriver,
  schema: string,
  declared: readonly DeclaredTable[],
  live: readonly LiveTable[],
  owned: DeclarationSnapshot,
  tombstoned: ReadonlySet<string>,
): SchemaPlan {
  const statements: PlannedStatement[] = [];
  const tombstones: PlannedTombstone[] = [];
  const revived: string[] = [];
  const inertRenames: string[] = [];
  const refusals: Refusal[] = [];
  const liveTables = liveByName(live);
  const declaredKeys = new Set<string>();

  const emit = (phase: PlanPhase, describes: string, sql: readonly string[]): void => {
    for (const one of sql) statements.push({ phase, sql: one, describes });
  };
  // NOT named `declare`: `declare` is a TypeScript modifier keyword, and a
  // statement that begins with it is parsed as an ambient declaration and
  // STRIPPED by a type-stripping transpiler — so `declare({ … });` at statement
  // position vanished while `const k = declare(…)` survived, and the pass
  // tombstoned every object it had just declared. Silent under Node, silent at
  // `tsc`, and destructive only on the runtime that strips types.
  const markDeclared = (id: SchemaObjectId): string => {
    const key = objectKey(id);
    declaredKeys.add(key);
    if (tombstoned.has(key)) revived.push(key);
    return key;
  };

  for (const table of declared) {
    markDeclared({ kind: "table", table: table.name });
    for (const column of table.columns) {
      markDeclared({ kind: "column", table: table.name, name: column.name });
    }
    const liveTable = liveTables.get(table.name);

    if (!liveTable) {
      emit("table", `table ${table.name}`, driver.createTable(schema, table));
    } else {
      const liveColumns = new Map(liveTable.columns.map((c) => [c.name, c]));
      for (const column of table.columns) {
        const existing = liveColumns.get(column.name);
        if (!existing) {
          const renamedFrom = column.renamedFrom;
          const source = renamedFrom ? liveColumns.get(renamedFrom) : undefined;
          // Classified BEFORE anything is emitted, so a refused rename
          // contributes no statements at all. The runner refuses to execute a
          // plan carrying refusals, but a plan that is half a rename is still
          // the wrong thing to hand anyone.
          if (source && renamedFrom) {
            // A rename that changes the type is two changes wearing one name.
            // Unchecked, the copy is a raw driver error on an engine that
            // refuses the assignment, and silently stores the old
            // representation on one that does not.
            const safety = driver.classifyCopy(source, column);
            if (!safety.safe) {
              refusals.push({
                object: `${table.name}.${column.name}`,
                reason: `renamedFrom '${renamedFrom}': ${safety.reason}`,
              });
              continue;
            }
          }
          emit(
            "table",
            `column ${table.name}.${column.name}`,
            driver.addColumn(schema, table.name, column),
          );
          // Expand-contract: the source column is copied, then tombstoned. A
          // native RENAME would take effect immediately and break the older
          // version still running — the one operation that would be exempt from
          // the deferral this design exists for.
          if (source && renamedFrom) {
            emit(
              "table",
              `copy ${table.name}.${renamedFrom} → ${column.name}`,
              driver.copyColumn(schema, table.name, renamedFrom, column.name),
            );
          }
          continue;
        }
        if (!columnDiffers(driver, existing, column)) continue;
        // Classification happens here, against live state, because the
        // declaration is the only artifact: there is no historical declared
        // state to diff against, so whether a change is safe depends on what is
        // in the column right now.
        const safety = driver.classifyAlter(existing, column);
        if (!safety.safe) {
          refusals.push({ object: `${table.name}.${column.name}`, reason: safety.reason });
          continue;
        }
        emit(
          "table",
          `column ${table.name}.${column.name}`,
          driver.alterColumn(schema, table.name, existing, column),
        );
      }
    }

    // A rename is inert when its source is gone for good: not present, and not
    // held by a tombstone. Only asked of a table that ALREADY existed — on one
    // this pass creates there was never anything to copy, so every rename would
    // look finished when in fact it has not run anywhere yet, and the same
    // manifest still deploys to databases that do need it.
    if (liveTable) {
      const liveColumnNames = new Set(liveTable.columns.map((c) => c.name));
      for (const column of table.columns) {
        if (!column.renamedFrom) continue;
        const sourceKey = objectKey({
          kind: "column",
          table: table.name,
          name: column.renamedFrom,
        });
        if (liveColumnNames.has(column.renamedFrom) || tombstoned.has(sourceKey)) continue;
        inertRenames.push(
          `column ${table.name}.${column.name} (renamedFrom ${column.renamedFrom})`,
        );
      }
    }

    const liveIndexes = new Map((liveTable?.indexes ?? []).map((index) => [index.name, index]));
    for (const index of table.indexes) {
      markDeclared({ kind: "index", table: table.name, name: index.name });
      const existing = liveIndexes.get(index.name);
      if (!existing) {
        emit("index", `index ${index.name}`, driver.createIndex(schema, table.name, index));
        continue;
      }
      // An index that exists under the right name may still cover the wrong
      // columns, or have stopped being unique. Silence there is the declaration
      // asserting something the database is not doing.
      if (!indexDiffers(existing, index)) continue;
      const safety = driver.classifyIndexChange(existing, index);
      if (!safety.safe) {
        refusals.push({ object: `${table.name}.${index.name}`, reason: safety.reason });
        continue;
      }
      emit("index", `index ${index.name}`, [
        ...driver.dropIndex(schema, table.name, index.name),
        ...driver.createIndex(schema, table.name, index),
      ]);
    }

    // A table this pass just created already carries its keys where the engine
    // can only emit them there. They are still MARKED declared, or the next boot
    // would read every one of them as removed and tombstone it.
    const carriedByCreate = !liveTable && driver.foreignKeysInCreateTable;
    // Where the engine keeps no name, a declaration is matched to a live key by
    // its structure. Matching by name regardless is what made such a table
    // unrestartable: every later boot read its own key as missing and refused to
    // add what the engine cannot add. Matches are CONSUMED, so two keys that are
    // structurally identical pair up one for one instead of both claiming the
    // first.
    const unmatched = [...(liveTable?.foreignKeys ?? [])];
    const liveForeignKeys = new Map(unmatched.map((fk) => [fk.name, fk]));
    const takeStructural = (fk: DeclaredForeignKey): LiveForeignKey | undefined => {
      const at = unmatched.findIndex((live) => sameForeignKeyIdentity(live, fk));
      return at < 0 ? undefined : unmatched.splice(at, 1)[0];
    };
    for (const fk of table.foreignKeys) {
      markDeclared({ kind: "foreignKey", table: table.name, name: fk.name });
      if (carriedByCreate) continue;
      const existing = driver.namesForeignKeys
        ? liveForeignKeys.get(fk.name)
        : takeStructural(fk);
      if (!existing) {
        emit("constraint", `foreign key ${fk.name}`, driver.addForeignKey(schema, table.name, fk));
        continue;
      }
      if (!foreignKeyDiffers(existing, fk)) continue;
      const safety = driver.classifyForeignKeyChange(existing, fk);
      if (!safety.safe) {
        refusals.push({ object: `${table.name}.${fk.name}`, reason: safety.reason });
        continue;
      }
      emit("constraint", `foreign key ${fk.name}`, [
        ...driver.dropForeignKey(schema, table.name, fk.name),
        ...driver.addForeignKey(schema, table.name, fk),
      ]);
    }
  }

  // Removal never emits DDL. An object this resource once declared and no longer
  // does is tombstoned; the drop is deferred to reclamation, which is the whole
  // point. An object it has NEVER declared is not ours and is not considered.
  const tombstoneKeys = new Set<string>();
  const tombstone = (id: SchemaObjectId, key: string, definition: string): void => {
    if (tombstoneKeys.has(key)) return;
    tombstoneKeys.add(key);
    tombstones.push({ id, key, definition });
  };
  // A table that is going away takes its columns, indexes and constraints with
  // it, so only the TABLE is tombstoned. Recording the children too would plan a
  // drop for each — and they are dropped first, since reclamation walks
  // dependents before their table — so an engine that refuses to drop a primary
  // key or an indexed column (SQLite refuses both) would fail the pass, and go
  // on failing it, over objects the DROP TABLE was about to remove anyway.
  const retiredTables = new Set(
    Object.keys(owned)
      .filter((key) => key.startsWith("table:"))
      .map((key) => parseObjectKey(key).table)
      .filter((table) => !declaredKeys.has(objectKey({ kind: "table", table }))),
  );
  for (const [key, definition] of Object.entries(owned)) {
    if (declaredKeys.has(key) || tombstoned.has(key)) continue;
    const id = parseObjectKey(key);
    if (id.kind !== "table" && retiredTables.has(id.table)) continue;
    tombstone(id, key, definition);
  }

  // A renamed-away source column is tombstoned even while the declaration still
  // names it through `renamedFrom`, so its budget starts at the rename rather
  // than at whichever later release deletes the mention.
  //
  // Only a source that is actually THERE. Once a rename's source has been
  // reclaimed the mention is inert, and tombstoning it again would put a column
  // that no longer exists back on the books and eventually emit a DROP for it.
  for (const table of declared) {
    const liveColumnNames = new Set(
      (liveTables.get(table.name)?.columns ?? []).map((c) => c.name),
    );
    for (const column of table.columns) {
      if (!column.renamedFrom) continue;
      if (!liveColumnNames.has(column.renamedFrom)) continue;
      const id: SchemaObjectId = { kind: "column", table: table.name, name: column.renamedFrom };
      const key = objectKey(id);
      if (tombstoned.has(key) || declaredKeys.has(key)) continue;
      tombstone(id, key, owned[key] ?? JSON.stringify({ name: column.renamedFrom }));
    }
  }

  return { statements, tombstones, revived, inertRenames, refusals };
}

export function describeRefusals(refusals: readonly Refusal[]): string {
  return refusals.map((r) => `  ${r.object}: ${r.reason}`).join("\n");
}
