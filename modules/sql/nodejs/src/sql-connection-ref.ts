import type { ResourceContext } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";

interface ConnectionRef {
  name: string;
}

export function resolveSqlConnection(
  value: SqlConnectionResource | ConnectionRef | undefined,
  ctx: ResourceContext,
): SqlConnectionResource | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof (value as SqlConnectionResource).execute === "function") {
    return value as SqlConnectionResource;
  }

  if (typeof (value as ConnectionRef).name !== "string") {
    throw new Error("Sql: invalid connection reference");
  }

  return ctx.moduleContext.getInstance((value as ConnectionRef).name) as SqlConnectionResource;
}
