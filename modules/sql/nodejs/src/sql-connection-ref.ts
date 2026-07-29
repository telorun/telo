import type { KindRef, ResourceContext } from "@telorun/sdk";
import type { SqlConnection } from "./sql-connection.js";

/** True when a value already exposes the connection contract (Phase-5 injected). */
export function isSqlConnection(value: unknown): value is SqlConnection {
  return typeof (value as SqlConnection | undefined)?.execute === "function";
}

/**
 * Resolve a `connection` `!ref` field to a live connection. The slot is optional
 * — an unset one yields `undefined` so the caller can fall back to a `transaction`
 * — but a slot that IS set must resolve. `describe` names the owning resource and
 * slot, so the failure points at a concrete manifest location.
 */
export function resolveSqlConnection(
  value: SqlConnection | KindRef<SqlConnection> | undefined,
  ctx: ResourceContext,
  describe: () => string,
): SqlConnection | undefined {
  if (!value) return undefined;
  return ctx.resolveRef(value, isSqlConnection, describe, "std/sql#Connection");
}
