import type { ResourceContext } from "@telorun/sdk";
import { quoteAnsiIdentifier, SqlConnectionBase, type SqlDialect } from "@telorun/sql";
import { Kysely, SqliteAdapter, SqliteDialect, type Driver } from "kysely";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase as openBunDatabase } from "./sqlite-driver-bun.js";
import type { SqliteDb } from "./sqlite-driver-interface.js";
import { openDatabase as openNodeDatabase } from "./sqlite-driver-node.js";
import { LOCK_WAIT_MS, LockWaitingSqliteDriver } from "./sqlite-lock-wait.js";

interface SqliteConnectionManifest {
  metadata: { name: string; module: string };
  /** File path, or omitted / `:memory:` for an in-memory database. */
  file?: string;
}

export const sqliteDialect: SqlDialect = {
  placeholderStyle: "qmark",
  quoteIdentifier: quoteAnsiIdentifier,
  // SQLite has no array type, so set membership expands to one placeholder per
  // element.
  renderIn(column, values, addParam) {
    return `${column} IN (${values.map((value) => addParam(value)).join(", ")})`;
  },
  // Julian day number of the Unix epoch, scaled to milliseconds.
  renderCurrentTimeMillis() {
    return "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  },
};

class SqliteConnection extends SqlConnectionBase {
  constructor(
    db: Kysely<any>,
    private readonly sqlite: SqliteDb,
    ctx: ResourceContext,
  ) {
    super(db, sqliteDialect, ctx);
  }

  /** The driver's native multi-statement entry point — kysely binds one
   *  statement per call. */
  override async executeScript(sql: string): Promise<void> {
    // A script cannot be retried half-way, so it waits natively, blocking.
    this.sqlite.busyTimeout(LOCK_WAIT_MS);
    try {
      this.sqlite.exec(sql);
    } finally {
      this.sqlite.busyTimeout(0);
    }
  }
}

// Kysely's stock SQLite adapter reports `supportsTransactionalDdl = false`, so
// its Migrator runs migrations without a transaction. SQLite does support
// transactional DDL, so we flip the flag — letting the Migrator wrap the whole
// migration batch in a single transaction, matching PostgreSQL.
class TransactionalSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

class TransactionalSqliteDialect extends SqliteDialect {
  readonly #database: SqliteDb;

  constructor(database: SqliteDb) {
    super({ database: database });
    this.#database = database;
  }

  override createAdapter(): SqliteAdapter {
    return new TransactionalSqliteAdapter();
  }

  override createDriver(): Driver {
    return new LockWaitingSqliteDriver({ database: this.#database });
  }
}

async function openSqliteDatabase(file: string, ctx: ResourceContext): Promise<SqliteDb> {
  // Auto-create the parent directory for file-backed databases. SQLite
  // drivers fail-fast when the directory doesn't exist; mirroring `mkdir
  // -p` here lets manifests use paths like `./tmp/foo.sqlite` without a
  // separate filesystem-prep step. `:memory:` skips filesystem entirely.
  if (file !== ":memory:") {
    const dir = dirname(file);
    if (dir && dir !== "." && dir !== "/") {
      await mkdir(dir, { recursive: true });
    }
  }

  if (process.versions.bun) {
    return openBunDatabase(file);
  }
  // The addon is the module's own `native:` file for this host, never one
  // better-sqlite3 would search for beside itself — a bundle has no package
  // directory to search.
  const addon = fileURLToPath(await ctx.resolveNativeFile("better-sqlite3"));
  return openNodeDatabase(file, addon);
}

// Declared foreign keys are part of the connection's contract, so a driver that
// did not switch enforcement on is a failed connection, not a weaker one.
function assertForeignKeysEnforced(sqlite: SqliteDb, name: string): void {
  const rows = sqlite.prepare("PRAGMA foreign_keys").all([]) as Array<{ foreign_keys?: unknown }>;
  const enabled = rows.length === 1 && Number(rows[0].foreign_keys) === 1;
  if (enabled) return;
  const driver = process.versions.bun ? "bun:sqlite" : "better-sqlite3";
  sqlite.close();
  throw new Error(
    `SQLite.Connection "${name}": the ${driver} driver did not enable foreign-key enforcement ` +
      `(PRAGMA foreign_keys reads ${rows.length === 0 ? "nothing" : String(rows[0].foreign_keys)}). ` +
      `The SQLite library this host loads was built without foreign-key support; ` +
      `run on a SQLite build that supports it.`,
  );
}

export function register(): void {}

export async function create(
  resource: SqliteConnectionManifest,
  ctx: ResourceContext,
): Promise<SqliteConnection> {
  const sqlite = await openSqliteDatabase(resource.file ?? ":memory:", ctx);
  assertForeignKeysEnforced(sqlite, resource.metadata.name);
  const db = new Kysely<any>({
    dialect: new TransactionalSqliteDialect(sqlite),
  });
  return new SqliteConnection(db, sqlite, ctx);
}
