import type { InvokeContext, ResourceContext, ZoneEntry } from "@telorun/sdk";
import type { SqlConnection } from "@telorun/sql";

/**
 * Runs `body` in one transaction: the caller's when one is open on this
 * connection, else one of its own. `zone` is what the body's statements name to
 * run on it; it is absent when the caller's transaction is ambient.
 */
export function inTransaction<T>(
  ctx: ResourceContext,
  connection: SqlConnection,
  invokeCtx: InvokeContext | undefined,
  body: (zone: ZoneEntry | undefined) => Promise<T>,
): Promise<T> {
  if (connection.hasOpenTransaction(invokeCtx)) return body(undefined);
  return connection.runInTransaction((bind) => {
    const entry: ZoneEntry = { kind: ctx.self.ref.kind, provider: ctx.self };
    bind(entry);
    return body(entry);
  }, invokeCtx);
}
