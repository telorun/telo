import { parseDurationMs, type ResourceContext } from "@telorun/sdk";
import type { DeclaredTable } from "./declared-schema.js";
import { describeObject } from "./declared-schema.js";
import { snapshotDeclaration, snapshotDigest, parseObjectKey } from "./declaration-snapshot.js";
import type { SchemaDriver } from "./schema-driver.js";
import { ledgerTables, SchemaLedger, type TombstoneRecord } from "./schema-ledger.js";
import { assessTombstone, type ReclaimPolicy } from "./reclaim-policy.js";
import {
  migrationStatements,
  orphanedKeys,
  runMigrations,
  type MigrationMap,
} from "./migration-runner.js";
import { describeRefusals, planReconciliation } from "./schema-reconciler.js";

export interface SchemaRunInput {
  readonly schema: string;
  /**
   * Which ledger this schema keeps its history in — the per-set name, or
   * undefined for the default. Two schema resources over one namespace MUST
   * name different ledgers: the ledger records the declaration, so a shared one
   * would make each read the other's tables as removed.
   */
  readonly ledger?: string;
  /** The released version this deployment is running. Absent when no `reclaim:`
   *  policy is declared — nothing else reads it. */
  readonly version?: string;
  readonly tables: readonly DeclaredTable[];
  readonly beforeMigrations: MigrationMap;
  readonly migrations: MigrationMap;
  readonly reclaim?: ReclaimPolicy;
}

/** What the pass did, reported as observed state so there is nothing to invoke to see it. */
export interface PendingReclamation {
  readonly object: string;
  readonly missingSinceVersion: string;
  /** `null` when no `reclaim:` policy is declared — nothing is ever dropped, so
   *  there is no budget to count down, only the fact that the object is held. */
  readonly versionsRemaining: number | null;
  readonly msRemaining: number | null;
  readonly eligible: boolean;
  /** Present when the engine cannot drop an object of this kind at all: the
   *  tombstone stands, and this says what has to happen instead. */
  readonly unreclaimable?: string;
}

export interface SchemaRunStatus {
  /** The released version this deployment is running. Absent when no `reclaim:`
   *  policy is declared — nothing else reads it. */
  readonly version?: string;
  readonly digest: string;
  readonly sequence: number;
  readonly migrationsApplied: string[];
  readonly orphanedMigrations: string[];
  readonly tombstoned: string[];
  readonly revived: string[];
  readonly inertRenames: string[];
  readonly reclaimed: string[];
  readonly pendingReclamation: PendingReclamation[];
}

/**
 * The boot pass, in one defined order: lock, before-migrations, reconcile,
 * migrations, record the version, tombstone, reclaim.
 *
 * The order is the reason schema change is ONE kind. Imperative and declarative
 * schema change need the same lock, the same bookkeeping and a defined order
 * between them; as separate kinds that order would live in the author's
 * `targets:` list, invisible and uncheckable.
 *
 * The version row is written only once reconciliation and both migration phases
 * have succeeded. A pass that fails before that records nothing, and the next
 * boot re-derives everything from live state — which is what keeps the clock
 * that gates an irreversible drop from advancing on a half-applied pass.
 */
/**
 * Ledgers already claimed on a connection, so two schema resources sharing one
 * cannot silently share a history.
 *
 * Hung off the CONNECTION INSTANCE rather than held in module scope: a
 * controller bundle inlines its own copy of a shared source file, so a module
 * global is one map per bundle and every lookup a miss (the payload rule,
 * kernel/specs/execution-zones.md §8).
 *
 * This sees only what one process declares. Two APPLICATIONS sharing a namespace
 * with the same ledger name are invisible here — as they are to every tool that
 * separates history by table name — which is why the rule is also documented.
 */
const claimedLedgers = new WeakMap<object, Set<string>>();

function claimLedger(connection: object, schema: string, versionsTable: string): void {
  const key = `${schema}\u0000${versionsTable}`;
  let claimed = claimedLedgers.get(connection);
  if (!claimed) claimedLedgers.set(connection, (claimed = new Set()));
  if (claimed.has(key)) {
    throw new Error(
      `Two schema resources share the ledger '${versionsTable}' in namespace '${schema}' on one ` +
        `connection. The ledger records what its schema declares, so a shared one would make ` +
        `each read the other's tables as removed and eventually drop them. Give one of them its ` +
        `own: 'ledger: <name>'.`,
    );
  }
  claimed.add(key);
}

/**
 * One physical table has ONE schema resource that manages it.
 *
 * Giving two of them separate ledgers keeps their HISTORIES apart, which is what
 * the ledger name is for — but it says nothing about the tables themselves.
 * Two resources declaring one table is worse than a shared history: remove it
 * from one and that ledger tombstones it and eventually drops it, while the
 * other recreates it empty on its next boot through `CREATE TABLE IF NOT
 * EXISTS`. The data is gone and both manifests still look correct.
 */
function claimTable(connection: object, schema: string, table: string): void {
  const key = `${schema}\u0000table:${table}`;
  let claimed = claimedLedgers.get(connection);
  if (!claimed) claimedLedgers.set(connection, (claimed = new Set()));
  if (claimed.has(key)) {
    throw new Error(
      `Two schema resources declare the table '${table}' in namespace '${schema}' on one ` +
        `connection. One table has one schema resource that manages it: were it removed from ` +
        `one declaration, that schema would drop it while the other recreated it empty.`,
    );
  }
  claimed.add(key);
}

export async function runSchemaPass(
  driver: SchemaDriver,
  ctx: ResourceContext,
  input: SchemaRunInput,
): Promise<SchemaRunStatus> {
  return driver.withLock(input.schema, () => pass(driver, ctx, input));
}

async function pass(
  driver: SchemaDriver,
  ctx: ResourceContext,
  input: SchemaRunInput,
): Promise<SchemaRunStatus> {
  const now = () => driver.now();
  const tables = ledgerTables(input.ledger);
  claimLedger(driver.connection, input.schema, tables.versions);
  for (const table of input.tables) claimTable(driver.connection, input.schema, table.name);
  const ledger = new SchemaLedger(driver, input.schema, tables);
  await driver.runAtomically(driver.ensureNamespaceStatements(input.schema));
  await ledger.ensureTables();

  const applied = await ledger.appliedMigrationKeys();
  const history = await ledger.versionHistory();
  const owned = history[history.length - 1]?.declaration ?? {};
  const tombstones = await ledger.tombstones();
  const tombstonedKeys = new Set(tombstones.map((t) => t.objectKey));

  // The version is the reclamation clock. Declaring a policy without one would
  // make every boot look like the same release, so no tombstone would ever age
  // and the policy would silently never fire. The schema requires the pair; this
  // is the same rule for a caller reaching the library directly, and it also
  // catches an expression that evaluated to nothing.
  // Allowed — the tests need it and an author may genuinely want it — but never
  // silent: the time window is the backstop that exists because several releases
  // can land in an afternoon, and zero switches it off, leaving `afterVersions`
  // alone to gate an irreversible drop. A static diagnostic belongs to the
  // declaration-consistency mechanism (analyzer/nodejs/plans/); until that
  // lands, saying it at boot is better than not saying it.
  if (input.reclaim && parseDurationMs(input.reclaim.afterDuration) === 0) {
    ctx.log.warn("Reclamation has no time backstop", {
      "sql.schema.reclaim.afterVersions": input.reclaim.afterVersions,
    });
  }

  const declaredVersion = input.version?.trim() ?? "";
  if (input.reclaim && declaredVersion === "") {
    throw new Error(
      `Schema '${input.schema}': 'reclaim' is declared without a 'version'. The version is the ` +
        `clock reclamation is gated on — without one every boot looks like the same release, so ` +
        `nothing would ever age out. Declare it, conventionally as !cel "module.version".`,
    );
  }

  // Two declarations of one physical table in one schema resource would be
  // reconciled twice against one live table, each pass seeing the other's
  // columns as undeclared.
  const byPhysicalName = new Map<string, number>();
  for (const table of input.tables) {
    byPhysicalName.set(table.name, (byPhysicalName.get(table.name) ?? 0) + 1);
  }
  const duplicated = [...byPhysicalName].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicated.length > 0) {
    throw new Error(
      `Schema '${input.schema}': ${duplicated.map((n) => `'${n}'`).join(", ")} ` +
        `${duplicated.length === 1 ? "is declared" : "are declared"} by more than one table in ` +
        `this schema. One physical table has one declaration; a table in two namespaces means ` +
        `two schema resources.`,
    );
  }

  // A foreign key can only be created once its target exists, and this pass
  // creates exactly the tables it was given.
  const declaredNames = new Set(input.tables.map((table) => table.name));
  for (const table of input.tables) {
    for (const fk of table.foreignKeys) {
      if (declaredNames.has(fk.references.table)) continue;
      throw new Error(
        `Schema '${input.schema}': foreign key '${table.name}.${fk.name}' references table ` +
          `'${fk.references.table}', which this schema does not declare. Add it to 'tables:', ` +
          `or create the constraint in a 'migrations:' entry if the target is owned elsewhere.`,
      );
    }
  }

  // Phase is not part of identity — the ledger stores the key alone, which is
  // what lets a migration move between the two maps without re-running. The
  // price is that a key in BOTH is meaningless: the merge below would drop one
  // of them and the ledger would skip the other as already applied, so a
  // migration the author wrote would never run and nothing would say so.
  const collisions = Object.keys(input.beforeMigrations).filter(
    (key) => key in input.migrations,
  );
  if (collisions.length > 0) {
    throw new Error(
      `Schema '${input.schema}': ${collisions.map((k) => `'${k}'`).join(", ")} ` +
        `${collisions.length === 1 ? "is declared" : "are declared"} in both ` +
        `'beforeMigrations' and 'migrations'. A migration key is its identity across both ` +
        `phases, so it may appear in only one — move it to the phase it belongs in.`,
    );
  }

  // Both phases are checked for statements up front, so a malformed entry fails
  // before any DDL has run rather than between two that have.
  for (const [key, entry] of Object.entries({ ...input.beforeMigrations, ...input.migrations })) {
    migrationStatements(key, entry);
  }

  const beforeApplied = await runMigrations(
    driver,
    ledger,
    input.beforeMigrations,
    applied,
    now,
  );
  for (const key of beforeApplied) applied.add(key);

  const live = await driver.introspect(
    input.schema,
    input.tables.map((table) => table.name),
  );
  const plan = planReconciliation(
    driver,
    input.schema,
    input.tables,
    live,
    owned,
    tombstonedKeys,
  );
  if (plan.refusals.length > 0) {
    // Never applied, never skipped: the release stops here.
    throw new Error(
      `Schema '${input.schema}': ${plan.refusals.length} declared change(s) cannot be applied ` +
        `safely to the data already present:\n${describeRefusals(plan.refusals)}`,
    );
  }
  for (const phase of ["table", "index", "constraint"] as const) {
    const statements = plan.statements.filter((s) => s.phase === phase);
    if (statements.length === 0) continue;
    await driver.runAtomically(statements.map((s) => s.sql));
    for (const statement of statements) {
      ctx.log.info("Schema reconciled", { "sql.schema.object": statement.describes });
    }
  }

  const afterApplied = await runMigrations(driver, ledger, input.migrations, applied, now);
  for (const key of afterApplied) applied.add(key);

  const at = await driver.now();
  const declaration = snapshotDeclaration(input.tables);
  const digest = snapshotDigest(declaration);

  // One group. The version row records the NEW declaration as owned, and the
  // tombstones record what the old one had that this one does not — so a crash
  // between them loses those objects for ever: the next boot's `owned` no longer
  // mentions them, nothing tombstones them again, and they sit in the database
  // untracked and undroppable. Committing them together is the same rule
  // `runMigrations` follows for a migration and its ledger row.
  const versionWrite = ledger.versionRecordStatements(
    declaredVersion,
    declaration,
    digest,
    at,
    await ledger.versionHistory(),
  );
  const version = versionWrite.record;
  await driver.runAtomically([
    ...versionWrite.statements,
    ...plan.tombstones.map((entry) =>
      ledger.tombstoneRecordStatement(entry.id, entry.key, entry.definition, version, at),
    ),
  ]);
  for (const entry of plan.tombstones) {
    ctx.log.info("Schema object tombstoned", {
      "sql.schema.object": describeObject(entry.id),
      "sql.schema.version": version.version,
    });
  }
  // A revival is idempotent on its own — the tombstone is simply gone — so it
  // needs no place in the group above.
  for (const key of plan.revived) await ledger.clearTombstone(key);

  // Dependents before the thing they hang off. Inherited from `ORDER BY
  // object_key` this happened to be right — `c` < `f` < `i` < `t` — which is a
  // property of the words, not of the design, and nothing said so or tested it.
  const RECLAIM_ORDER: Record<string, number> = { foreignKey: 0, index: 1, column: 2, table: 3 };
  const outstanding = (await ledger.tombstones())
    .filter((t) => !plan.revived.includes(t.objectKey))
    .sort((a, b) => (RECLAIM_ORDER[a.kind] ?? 9) - (RECLAIM_ORDER[b.kind] ?? 9));
  const reclaimed = await reclaim(driver, ledger, ctx, input, outstanding, at);

  return {
    version: version.version,
    digest,
    sequence: version.sequence,
    migrationsApplied: [...beforeApplied, ...afterApplied],
    orphanedMigrations: orphanedKeys(applied, input.beforeMigrations, input.migrations),
    tombstoned: plan.tombstones.map((t) => describeObject(t.id)),
    revived: plan.revived.map((key) => describeObject(parseObjectKey(key))),
    inertRenames: [...plan.inertRenames],
    reclaimed: reclaimed.dropped,
    pendingReclamation: reclaimed.pending,
  };
}

/**
 * Reclamation runs automatically, gated by the declared policy. The control is
 * declaring the policy at all: with none, nothing is ever dropped and the
 * ledger still reports what WOULD be eligible, so a schema can run indefinitely
 * with reclamation declared nowhere and still show what it is holding.
 */
async function reclaim(
  driver: SchemaDriver,
  ledger: SchemaLedger,
  ctx: ResourceContext,
  input: SchemaRunInput,
  tombstones: readonly TombstoneRecord[],
  at: string,
): Promise<{ dropped: string[]; pending: PendingReclamation[] }> {
  const history = await ledger.versionHistory();
  const nowMs = Date.parse(at);
  const dropped: string[] = [];
  const pending: PendingReclamation[] = [];

  for (const tombstone of tombstones) {
    const id = parseObjectKey(tombstone.objectKey);
    const described = describeObject(id);
    if (!input.reclaim) {
      pending.push({
        object: described,
        missingSinceVersion: tombstone.missingSinceVersion,
        versionsRemaining: null,
        msRemaining: null,
        eligible: false,
      });
      continue;
    }
    // A tombstone this engine cannot act on is left standing and REPORTED with
    // the reason. Attempting it would fail the boot, and since the tombstone
    // stays eligible it would fail every boot after it too — the application
    // would never start again over a schema object nobody is waiting on.
    const support = driver.canReclaim(id);
    if (!support.safe) {
      pending.push({
        object: described,
        missingSinceVersion: tombstone.missingSinceVersion,
        versionsRemaining: null,
        msRemaining: null,
        eligible: false,
        unreclaimable: support.reason,
      });
      ctx.log.warn("Schema object cannot be reclaimed by this engine", {
        "sql.schema.object": described,
      });
      continue;
    }

    const verdict = assessTombstone(tombstone, history, input.reclaim, nowMs);
    if (!verdict.eligible) {
      pending.push({
        object: described,
        missingSinceVersion: tombstone.missingSinceVersion,
        versionsRemaining: verdict.versionsRemaining,
        msRemaining: verdict.msRemaining,
        eligible: false,
      });
      continue;
    }
    const statements =
      id.kind === "table"
        ? driver.dropTable(input.schema, id.table)
        : id.kind === "column"
          ? driver.dropColumn(input.schema, id.table, id.name!)
          : id.kind === "index"
            ? driver.dropIndex(input.schema, id.table, id.name!)
            : driver.dropForeignKey(input.schema, id.table, id.name!);
    // A drop can still fail for a reason `canReclaim` cannot see — a dependent
    // view, a lock timeout, a constraint discovered at the moment it runs. That
    // must not be why the application stops starting: the tombstone stays
    // eligible, so an unguarded failure here would fail this boot and every boot
    // after it. Reported through the channel that already exists for held
    // objects, and left standing.
    try {
      await driver.runAtomically(statements);
    } catch (error) {
      // The reason travels with the log, not only in observed state: this is on
      // the boot path, and a warning that says an object could not be dropped
      // without saying why sends the reader to a status field they may not be
      // looking at.
      ctx.log.warn("Schema object could not be reclaimed", {
        "sql.schema.object": described,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      pending.push({
        object: described,
        missingSinceVersion: tombstone.missingSinceVersion,
        versionsRemaining: 0,
        msRemaining: 0,
        eligible: true,
        unreclaimable: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    await ledger.clearTombstone(tombstone.objectKey);
    dropped.push(described);
    ctx.log.info("Schema object reclaimed", {
      "sql.schema.object": described,
      "sql.schema.version": tombstone.missingSinceVersion,
    });
  }
  return { dropped, pending };
}
