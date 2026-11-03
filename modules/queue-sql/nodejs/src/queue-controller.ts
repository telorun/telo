import {
  durationNanos,
  getRefIdentity,
  isCelDuration,
  type ResourceContext,
} from "@telorun/sdk";
import {
  rendersInstantArithmetic,
  rendersLockSkipping,
  resolveSqlConnection,
  type SqlConnection,
} from "@telorun/sql";
import { queueSettingsOf } from "@telorun/queue";
import { groupByOf } from "./group-key.js";
import { isDeclaredTable } from "./queue-table.js";
import { SqlQueueStore } from "./sql-queue-store.js";

interface QueueManifest {
  kind: string;
  metadata: { name: string };
  connection?: unknown;
  schema?: unknown;
  table?: unknown;
  name?: unknown;
  retention?: unknown;
  groupBy?: unknown;
  messageType?: unknown;
  maxMessageBytes?: unknown;
}

export function register(): void {}

/** QueueSql.Queue — one named queue in a table on the application's own database. */
export async function create(resource: QueueManifest, ctx: ResourceContext): Promise<SqlQueueStore> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const connection = resolveSqlConnection(
    resource.connection as SqlConnection | undefined,
    ctx,
    () => `${describe}: 'connection'`,
  );
  if (!connection) throw new Error(`${describe}: 'connection' is required.`);
  const schema = ctx.resolveRef(
    resource.schema,
    // Any live instance, so one without the members is refused below by name.
    (candidate): candidate is object =>
      typeof candidate === "object" && candidate !== null && !!getRefIdentity(candidate),
    () => `${describe}: 'schema'`,
    "Sql.Schema",
  );
  if (!rendersInstantArithmetic(schema) || !rendersLockSkipping(schema)) {
    const identity = getRefIdentity(schema);
    throw new Error(
      `${describe}: 'schema' references '${identity?.name ?? "(inline)"}' of kind ` +
        `'${identity?.kind ?? "(unknown)"}', whose engine module predates the instant and ` +
        `lock-skipping members a queue needs — its schema instance cannot say how the store's ` +
        `clock is read and shifted, or how competing claims pass over rows another transaction ` +
        `holds. Upgrade the module that declares that kind.`,
    );
  }
  const table = ctx.resolveRef(resource.table, isDeclaredTable, () => `${describe}: 'table'`, "Sql.Table");
  const name = resource.name;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${describe}: 'name' must be an identifier.`);
  }
  const retention = resource.retention;
  if (!isCelDuration(retention) || durationNanos(retention) < 0n) {
    throw new Error(`${describe}: 'retention' must be a duration of at least 0s.`);
  }
  return new SqlQueueStore(
    describe,
    ctx,
    connection,
    schema,
    table,
    name,
    retention,
    groupByOf(describe, resource.groupBy),
    queueSettingsOf(resource, ctx),
  );
}
