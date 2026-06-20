import type { ResourceContext } from "@telorun/sdk";
import { createSqlConnection, type SqlConnectionResource, type SqliteDb } from "@telorun/sql";
import { Kysely, SqliteAdapter, SqliteDialect } from "kysely";

interface SqliteConnectionManifest {
  metadata: { name: string; module: string };
  /** File path, or omitted / `:memory:` for an in-memory database. */
  file?: string;
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
  override createAdapter(): SqliteAdapter {
    return new TransactionalSqliteAdapter();
  }
}

async function openSqliteDatabase(file = ":memory:"): Promise<SqliteDb> {
  // Auto-create the parent directory for file-backed databases. SQLite
  // drivers fail-fast when the directory doesn't exist; mirroring `mkdir
  // -p` here lets manifests use paths like `./tmp/foo.sqlite` without a
  // separate filesystem-prep step. `:memory:` skips filesystem entirely.
  if (file !== ":memory:") {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const dir = dirname(file);
    if (dir && dir !== "." && dir !== "/") {
      await mkdir(dir, { recursive: true });
    }
  }

  // Route through this package's own `./sqlite-driver` subpath export so the
  // resolver selects the driver per runtime (Bun → bun:sqlite, Node →
  // better-sqlite3). A manual `typeof Bun` check with relative imports gets
  // flattened by the controller bundler into an unconditional top-level
  // `import "bun:sqlite"`, which Node's ESM loader rejects before the guard
  // runs; an external `@telorun/*` specifier stays a deferred dynamic import.
  const { openDatabase } = await import("@telorun/sql-sqlite/sqlite-driver");
  return openDatabase(file);
}

export function register(): void {}

export async function create(
  resource: SqliteConnectionManifest,
  _ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  const sqlite = await openSqliteDatabase(resource.file ?? ":memory:");
  const db = new Kysely<any>({
    dialect: new TransactionalSqliteDialect({ database: sqlite }),
  });
  return createSqlConnection("sqlite", db, sqlite);
}
