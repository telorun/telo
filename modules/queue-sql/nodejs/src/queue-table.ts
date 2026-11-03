import type { DeclaredTable, SqlDialect } from "@telorun/sql";

/**
 * The queue table's layout. Every column is internal: the engine table kinds
 * declare them under `internalColumns`, so no row contract sees them, and the
 * layout changes only with this module and the engine Schema's migrations.
 *
 * One row is one message of one named queue. `seq` is an identity column: the
 * enqueue order a group is delivered in and the tail a listing resumes after.
 * `state` is what was last written — `pending`, `running`, `completed`, `dead`
 * or `cancelled`; whether a pending message is scheduled, and whether a running
 * one's lease lapsed, is read against the store's clock when asked.
 */
export const QUEUE_COLUMNS = {
  seq: "seq",
  queueName: "queue_name",
  messageId: "message_id",
  groupKey: "group_key",
  state: "state",
  body: "body",
  digest: "digest",
  envelopeGeneration: "envelope_generation",
  attempts: "attempts",
  enqueuedAt: "enqueued_at",
  visibleAt: "visible_at",
  leaseUntil: "lease_until",
  claimToken: "claim_token",
  settledAt: "settled_at",
  lastError: "last_error",
  dyingError: "dying_error",
  errorGeneration: "error_generation",
  cancelRequested: "cancel_requested",
  cancelReason: "cancel_reason",
  traceparent: "traceparent",
  tracestate: "tracestate",
} as const;

export type QueueColumn = keyof typeof QUEUE_COLUMNS;

/** Each column quoted in the connection's dialect. */
export type QueueColumns = { readonly [K in QueueColumn]: string };

/** A table resource as every engine's `Table` kind exposes it. */
export interface DeclaredTableHolder {
  readonly declaration: DeclaredTable;
}

export function isDeclaredTable(value: unknown): value is DeclaredTableHolder {
  const declaration = (value as DeclaredTableHolder | undefined)?.declaration;
  return (
    !!declaration && typeof declaration.name === "string" && Array.isArray(declaration.columns)
  );
}

/**
 * The columns of a table declared with an engine module's queue table kind. A
 * table declared any other way lacks them, and is refused here rather than at
 * the first statement.
 */
export function queueColumns(describe: string, table: DeclaredTable, dialect: SqlDialect): QueueColumns {
  const names = Object.values(QUEUE_COLUMNS);
  const missing = names.filter((column) => !table.internalColumns.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `${describe}: table '${table.name}' has no internal column ${missing
        .map((column) => `'${column}'`)
        .join(", ")}, so it cannot hold queue messages. Declare it with the engine module's own ` +
        `queue table kind.`,
    );
  }
  const quoted = {} as Record<QueueColumn, string>;
  for (const [key, column] of Object.entries(QUEUE_COLUMNS) as [QueueColumn, string][]) {
    quoted[key] = dialect.quoteIdentifier(column);
  }
  return quoted;
}
