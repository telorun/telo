import type { ResourceContext } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";

interface ConnectionRef {
  name: string;
  alias?: string;
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

  const ref = value as ConnectionRef;
  if (typeof ref.name !== "string") {
    throw new Error("Sql: invalid connection reference");
  }

  // Cross-module reference (`!ref Alias.Connection`): a connection resolved
  // inside a nested library is not Phase-5-injected, so the controller receives
  // the raw `{name, alias}` ref and must route through the import's exported
  // scope rather than a bare local lookup.
  if (ref.alias && ref.alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name);
    if (typeof (instance as SqlConnectionResource | undefined)?.execute !== "function") {
      throw new Error(
        `Sql: connection reference '${ref.alias}.${ref.name}' did not resolve to an exported connection instance.`,
      );
    }
    return instance as unknown as SqlConnectionResource;
  }

  return ctx.moduleContext.getInstance(ref.name) as SqlConnectionResource;
}
