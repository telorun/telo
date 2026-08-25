import type { DeclaredSeeds, DeclaredTable, SchemaObjectId } from "./declared-schema.js";
import { objectKey } from "./declared-schema.js";
import type { SchemaDriver } from "./schema-driver.js";

/**
 * Seed rows — reference data the table is declared to hold.
 *
 * **Seeds need no introspection.** The upsert is idempotent, so it simply runs;
 * the only history required is the previous declaration, which the ledger already
 * records — and that is also what a removal is diffed against. Nothing is read
 * back, which is what makes "a row deleted by hand comes back" true by
 * construction rather than by a reconciliation step.
 *
 * **A row asserts the columns it states and no others.** A row that declares no
 * `rank` leaves the insert to the column default and the update to whatever is
 * there. That is the answer to a seeded row edited in place: a column the seed
 * declares is restored on the next boot, because that is what declaring it
 * means; one it does not is the operator's.
 *
 * **A row removed from `rows:` is RECORDED, not deleted** — the tombstone rule
 * every other object follows, reclaimed under the same policy and held when a
 * foreign key still references it. Deleting rows is irreversible; nothing about
 * a row makes it the one object worth exempting.
 */

/** A row's durable identity, rendered from its key columns. Stable across boots
 *  and readable in a tombstone, which is what a reclamation report needs. */
export function seedRowKey(seeds: DeclaredSeeds, row: Record<string, unknown>): string {
  return seeds.key.map((column) => `${column}=${JSON.stringify(row[column] ?? null)}`).join(",");
}

export function seedRowId(table: string, key: string): SchemaObjectId {
  return { kind: "seedRow", table, name: key };
}

export interface SeedPlan {
  /** Upserts to run after the reconciliation pass, in declaration order. */
  readonly statements: readonly string[];
  /** Every seed row this declaration asserts, by ledger key. */
  readonly declaredKeys: ReadonlySet<string>;
}

/**
 * The upserts one boot runs, and the keys this declaration claims.
 *
 * A `when:` that evaluates false contributes NEITHER — which is what withdraws
 * the declaration, so the rows tombstone on a database that had them.
 */
export function planSeeds(
  driver: SchemaDriver,
  schema: string,
  tables: readonly DeclaredTable[],
): SeedPlan {
  const statements: string[] = [];
  const declaredKeys = new Set<string>();
  for (const table of tables) {
    const seeds = table.seeds;
    if (!seeds || !seeds.when) continue;
    for (const row of seeds.rows) {
      declaredKeys.add(objectKey(seedRowId(table.name, seedRowKey(seeds, row))));
      statements.push(...driver.upsertRow(schema, table.name, seeds.key, row));
    }
  }
  return { statements, declaredKeys };
}
