import type { SchemaLedger } from "./schema-ledger.js";
import type { SchemaDriver } from "./schema-driver.js";

/**
 * A migration is one `statement` or an ordered list of `statements`, keyed by a
 * durable id. Phase is NOT part of identity: keys are unique across both maps
 * and the ledger stores the key alone, so moving a migration between
 * `beforeMigrations:` and `migrations:` keeps its identity and does not re-run
 * it.
 */
export interface MigrationEntry {
  readonly statement?: string;
  readonly statements?: readonly string[];
}

export type MigrationMap = Record<string, MigrationEntry>;

export function migrationStatements(key: string, entry: MigrationEntry): string[] {
  const statements = entry.statements ?? (entry.statement != null ? [entry.statement] : []);
  if (statements.length === 0) {
    throw new Error(
      `migration '${key}' has no statement(s) — set 'statement' or a non-empty 'statements'`,
    );
  }
  return [...statements];
}

/** Keys not yet in the ledger, in key order — the order they are applied in. */
export function pendingKeys(migrations: MigrationMap, applied: ReadonlySet<string>): string[] {
  return Object.keys(migrations)
    .filter((key) => !applied.has(key))
    .sort();
}

/**
 * Apply the pending migrations in key order, each with its ledger row in the
 * SAME atomic group.
 *
 * Applying and recording are one operation, not two: a crash between them would
 * re-run a migration that may not be idempotent. Whether the group is genuinely
 * atomic is the engine's to say — {@link SchemaDriver.runAtomically} groups it
 * where DDL is transactional and runs it sequentially where it is not — but the
 * ledger write is never the thing left outstanding, because it is last in the
 * group.
 */
export async function runMigrations(
  driver: SchemaDriver,
  ledger: SchemaLedger,
  migrations: MigrationMap,
  applied: ReadonlySet<string>,
  now: () => Promise<string>,
): Promise<string[]> {
  const pending = pendingKeys(migrations, applied);
  for (const key of pending) {
    await driver.runAtomically([
      ...migrationStatements(key, migrations[key]!),
      ledger.migrationRecordStatement(key, await now()),
    ]);
  }
  return pending;
}

export function orphanedKeys(
  applied: ReadonlySet<string>,
  ...declared: readonly MigrationMap[]
): string[] {
  const known = new Set(declared.flatMap((map) => Object.keys(map)));
  return [...applied].filter((key) => !known.has(key)).sort();
}
