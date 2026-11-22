import { InvokeError } from "@telorun/sdk";

export const ERR_ONE_TIME_NAME_DUPLICATE = "ERR_ONE_TIME_NAME_DUPLICATE";

interface Claim {
  readonly owner: object;
  readonly describe: string;
}

/**
 * The names claimed on each store by the token sets bound to it — the runtime
 * twin of the `ONE_TIME_NAME_DUPLICATE` rule. Keyed on the store INSTANCE, so two
 * sets naming one store declaration meet here and two stores never do. It holds
 * this process's own sets only.
 */
const claims = new WeakMap<object, Map<string, Claim>>();

/** Claims `name` on `store` for `owner`; the returned closure releases it. */
export function claimTokenName(store: object, name: string, owner: object, describe: string): () => void {
  let names = claims.get(store);
  if (!names) claims.set(store, (names = new Map()));
  const existing = names.get(name);
  if (existing && existing.owner !== owner) {
    throw new InvokeError(
      ERR_ONE_TIME_NAME_DUPLICATE,
      `${describe} claims the name '${name}' on its store, which ${existing.describe} already claims. ` +
        "Their records would collide and a token of one would be redeemable on the other — " +
        "give each set a name of its own.",
      { name },
    );
  }
  names.set(name, { owner, describe });
  return () => {
    if (names.get(name)?.owner === owner) names.delete(name);
  };
}
