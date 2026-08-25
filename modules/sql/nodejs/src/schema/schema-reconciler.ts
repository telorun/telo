import type {
  DeclaredCheck,
  DeclaredColumn,
  DeclaredEnum,
  DeclaredForeignKey,
  DeclaredIndex,
  DeclaredTable,
  SchemaObjectId,
} from "./declared-schema.js";
import { isTableChild, objectKey } from "./declared-schema.js";
import type { DeclarationSnapshot } from "./declaration-snapshot.js";
import { parseObjectKey } from "./declaration-snapshot.js";
import { seedRowId, seedRowKey } from "./seed-rows.js";
import type {
  LiveCheck,
  LiveColumn,
  LiveEnum,
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

/**
 * DDL ordering. Cross-table constraints come last so declaration order is never
 * load-bearing and foreign-key ordering is never the author's problem.
 *
 * `enumValue` runs FIRST so a column can carry a value this same boot adds, and
 * `enum` creates absent types ahead of the tables so a column can name a type
 * this same boot creates.
 */
export type PlanPhase =
  | "enumValue"
  | "extension"
  | "enum"
  | "table"
  | "index"
  | "constraint";

/**
 * The phases, in the order the runner executes them.
 *
 * WHETHER a phase can share a transaction is the ENGINE's answer, not this
 * list's — see `SchemaDriver.transactionalPhase`. This list said `enumValue` is
 * always unwrapped "because PostgreSQL cannot use an enum value in the
 * transaction that adds it", which put one engine's transactional rule in the
 * half that exists not to know about engines; a backend whose `ALTER TYPE` is
 * transactional had no way to say so.
 */
export const PLAN_PHASES: readonly PlanPhase[] = [
  "enumValue",
  "extension",
  "enum",
  "table",
  "index",
  "constraint",
];

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
  /**
   * Enum values the declaration has dropped and the engine is keeping.
   *
   * No engine can remove an enum label without rewriting every table that stores
   * it, so the removal is RECORDED rather than executed — the tombstone rule the
   * schema design is already built on, applied to a value instead of an object.
   * Reported so it is visible rather than silent.
   */
  readonly retainedEnumValues: readonly string[];
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

/** What the pass reconciles, beyond the tables. Grouped so the signature does
 *  not grow a positional argument per object kind. */
export interface ReconciliationInput {
  readonly tables: readonly DeclaredTable[];
  readonly enums: readonly DeclaredEnum[];
  readonly extensions: readonly string[];
  readonly live: readonly LiveTable[];
  readonly liveEnums: readonly LiveEnum[];
  readonly liveExtensions: readonly string[];
  readonly owned: DeclarationSnapshot;
  readonly tombstoned: ReadonlySet<string>;
}

export function planReconciliation(
  driver: SchemaDriver,
  schema: string,
  input: ReconciliationInput,
): SchemaPlan {
  const {
    tables: declared,
    enums,
    extensions,
    live,
    liveEnums,
    liveExtensions,
    owned,
    tombstoned,
  } = input;
  const statements: PlannedStatement[] = [];
  const tombstones: PlannedTombstone[] = [];
  const revived: string[] = [];
  const inertRenames: string[] = [];
  const retainedEnumValues: string[] = [];
  /** Checks this pass dropped outright. They are excluded from the tombstone
   *  sweep below: the object is already gone, so recording it would hold a
   *  reclamation budget for something nothing is waiting on. */
  const droppedChecks = new Set<string>();
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

  // Extensions before everything: an extension is what makes a storage class
  // like `citext` available at all, so a column naming one needs it to exist
  // before the table is created.
  const presentExtensions = new Set(liveExtensions);
  for (const name of extensions) {
    markDeclared({ kind: "extension", table: name });
    if (!driver.namedExtensions || presentExtensions.has(name)) continue;
    emit("extension", `extension ${name}`, driver.createExtension(schema, name));
  }

  // Enums next, and their statements land in the phases that run ahead of the
  // tables — a column can then name a type this same boot creates.
  const liveEnumsByName = new Map(liveEnums.map((one) => [one.name, one]));
  for (const declaredEnum of enums) {
    markDeclared({ kind: "enum", table: declaredEnum.typeName });
    const existing = driver.namedEnumTypes
      ? liveEnumsByName.get(declaredEnum.typeName)
      : undefined;
    const recorded = ownedEnum(owned, declaredEnum.typeName);
    if (!recorded.ok) {
      refusals.push({ object: `enum ${declaredEnum.typeName}`, reason: recorded.reason });
      continue;
    }

    // An engine with no named type has nothing live to compare, so `owned` is
    // the comparison — which is exactly why the declaration is snapshotted whole.
    const safety = driver.classifyEnumChange(existing, declaredEnum, recorded.value);
    if (!safety.safe) {
      refusals.push({ object: `enum ${declaredEnum.typeName}`, reason: safety.reason });
      continue;
    }
    if (!driver.namedEnumTypes) continue;

    if (!existing) {
      emit("enum", `enum ${declaredEnum.typeName}`, driver.createEnum(schema, declaredEnum));
      continue;
    }
    const present = new Set(existing.values);
    const added = declaredEnum.values.filter((value) => !present.has(value));
    if (added.length > 0) {
      emit(
        "enumValue",
        `enum ${declaredEnum.typeName}`,
        driver.addEnumValues(schema, declaredEnum, added),
      );
    }
    const kept = new Set(declaredEnum.values);
    for (const value of existing.values) {
      if (!kept.has(value)) retainedEnumValues.push(`${declaredEnum.typeName}.${value}`);
    }
  }

  for (const table of declared) {
    markDeclared({ kind: "table", table: table.name });
    for (const column of table.columns) {
      markDeclared({ kind: "column", table: table.name, name: column.name });
    }
    // Seed rows are marked HERE, where every other object is, so the ordinary
    // sweep tombstones exactly the ones the declaration stopped naming — and
    // revives one it names again. A `when:` that evaluates false marks none,
    // which is what withdrawing the declaration means.
    if (table.seeds?.when) {
      for (const row of table.seeds.rows) {
        markDeclared(seedRowId(table.name, seedRowKey(table.seeds, row)));
      }
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

    const carriedChecks = !liveTable && driver.checksInCreateTable;
    // WHERE the comparison comes from is the engine difference, and the only
    // one. An engine that can alter a constraint reports its checks back and is
    // compared against live state; an engine that carries them inside CREATE
    // TABLE has nothing to read back, so the RECORDED declaration is the
    // comparison — which is why the declaration is snapshotted whole, exactly as
    // it is for an enum on such an engine.
    let liveChecks: Map<string, LiveCheck>;
    if (driver.checksInCreateTable) {
      const recorded = recordedChecks(owned, table.name);
      refusals.push(...recorded.unreadable);
      liveChecks = recorded.checks;
    } else {
      liveChecks = new Map((liveTable?.checks ?? []).map((check) => [check.name, check]));
    }
    for (const check of table.checks) {
      markDeclared({ kind: "check", table: table.name, name: check.name });
      if (carriedChecks) continue;
      const existing = liveChecks.get(check.name);
      if (!existing) {
        emit("constraint", `check ${check.name}`, driver.addCheck(schema, table.name, check));
        continue;
      }
      // A constraint added `NOT VALID` is proven on a LATER pass — that is what
      // `validate: deferred` buys, and it is why an unvalidated one is not simply
      // a difference to re-add.
      if (!existing.validated) {
        emit(
          "constraint",
          `check ${check.name}`,
          driver.validateCheck(schema, table.name, check.name),
        );
        continue;
      }
      if (!driver.checkDiffers(existing, check)) continue;
      const safety = driver.classifyCheckChange(existing, check);
      if (!safety.safe) {
        refusals.push({ object: `${table.name}.${check.name}`, reason: safety.reason });
        continue;
      }
      emit("constraint", `check ${check.name}`, [
        ...driver.dropCheck(schema, table.name, check.name),
        ...driver.addCheck(schema, table.name, check),
      ]);
    }

    // **Removing a check is IMMEDIATE — no tombstone, no reclaim.** A dropped
    // column can lose data, which is why removals are recorded and reclaimed on
    // a policy. A dropped constraint loses nothing, so recording it would put a
    // grace window on an object whose removal is free and leave the declaration
    // disagreeing with the database for a release cycle.
    if (liveTable) {
      const declaredChecks = new Set(table.checks.map((check) => check.name));
      for (const [name] of liveChecks) {
        const key = objectKey({ kind: "check", table: table.name, name });
        if (declaredChecks.has(name) || owned[key] === undefined) continue;
        emit("constraint", `check ${name}`, driver.dropCheck(schema, table.name, name));
        droppedChecks.add(key);
      }
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
    // A retired table takes its own children with it. An ENUM is not one of
    // them — it is a top-level object that happens to carry its physical name in
    // the same field — so it is never suppressed by a table of the same name.
    if (isTableChild(id.kind) && retiredTables.has(id.table)) continue;
    // A check this pass DROPPED needs no tombstone: the removal was free and it
    // has already happened.
    if (id.kind === "check" && droppedChecks.has(key)) continue;
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

  return { statements, tombstones, revived, inertRenames, retainedEnumValues, refusals };
}

/**
 * One ledger record, parsed — or the reason it could not be.
 *
 * **An unreadable record is never "absent".** The two mean opposite things: an
 * absent record says this schema has never declared the object, which is the
 * green light to create it and (for an enum on an engine with no live state to
 * compare) to accept any change to it. Degrading a corrupt record to absent
 * therefore accepted a changed enum declaration silently while every existing
 * table went on enforcing the old values. So the failure is surfaced, and the
 * caller turns it into a refusal — the pass stops rather than converging on the
 * wrong schema.
 */
type Recorded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function readRecord<T>(definition: string, key: string): Recorded<T> {
  try {
    return { ok: true, value: JSON.parse(definition) as T };
  } catch (error) {
    return {
      ok: false,
      reason:
        `its ledger record '${key}' is not readable as JSON ` +
        `(${error instanceof Error ? error.message : String(error)}), so this pass cannot tell ` +
        `what was previously declared. Repair or delete that row of the versions table.`,
    };
  }
}

/** The checks the ledger recorded for one table, read as live state — the
 *  comparison for an engine that carries a check inside `CREATE TABLE` and has
 *  nothing to read back. `validated` is true because such an engine has no
 *  unvalidated state to be in. */
function recordedChecks(
  owned: DeclarationSnapshot,
  table: string,
): { checks: Map<string, LiveCheck>; unreadable: Refusal[] } {
  const prefix = `check:${table}.`;
  const checks = new Map<string, LiveCheck>();
  const unreadable: Refusal[] = [];
  for (const [key, definition] of Object.entries(owned)) {
    if (!key.startsWith(prefix)) continue;
    const record = readRecord<DeclaredCheck>(definition, key);
    if (!record.ok) {
      unreadable.push({ object: key, reason: record.reason });
      continue;
    }
    const parsed = record.value;
    if (typeof parsed?.name !== "string") {
      unreadable.push({
        object: key,
        reason: `its ledger record declares no 'name', so it cannot be matched to a declaration.`,
      });
      continue;
    }
    checks.set(parsed.name, { name: parsed.name, expression: parsed.expression, validated: true });
  }
  return { checks, unreadable };
}

/** The enum declaration the ledger recorded. `undefined` means this schema has
 *  never declared one under that name — see {@link Recorded} for why that is
 *  kept apart from a record it cannot read. */
function ownedEnum(owned: DeclarationSnapshot, typeName: string): Recorded<DeclaredEnum | undefined> {
  const key = objectKey({ kind: "enum", table: typeName });
  const recorded = owned[key];
  if (recorded === undefined) return { ok: true, value: undefined };
  return readRecord<DeclaredEnum>(recorded, key);
}

export function describeRefusals(refusals: readonly Refusal[]): string {
  return refusals.map((r) => `  ${r.object}: ${r.reason}`).join("\n");
}
