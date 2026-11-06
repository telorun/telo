import { InvokeError } from "@telorun/sdk";

interface Claim {
  readonly owner: object;
  readonly describe: string;
}

/**
 * The names claimed inside each table, by the stores bound to it — the runtime
 * twin of the engine table kinds' `API_KEY_STORE_NAME_DUPLICATE` rule.
 *
 * Keyed on the table INSTANCE, so two stores naming one table declaration meet
 * here and two tables never do. It lives in this module's one scope, which every
 * engine module re-exports rather than inlines, so stores of any engine share
 * it.
 */
const claims = new WeakMap<object, Map<string, Claim>>();

/** Claims `name` in `table` for `owner`; the returned closure releases it. */
export function claimStoreName(
  table: object,
  tableName: string,
  name: string,
  owner: object,
  describe: string,
): () => void {
  let names = claims.get(table);
  if (!names) claims.set(table, (names = new Map()));
  const existing = names.get(name);
  if (existing && existing.owner !== owner) {
    throw new InvokeError(
      "ERR_API_KEY_STORE_NAME_DUPLICATE",
      `${describe} claims the name '${name}' in table '${tableName}', which ` +
        `${existing.describe} already claims. Two stores with one name in one table would ` +
        `read and revoke each other's keys — give each store a name of its own.`,
      { table: tableName, name },
    );
  }
  names.set(name, { owner, describe });
  return () => {
    if (names.get(name)?.owner === owner) names.delete(name);
  };
}
