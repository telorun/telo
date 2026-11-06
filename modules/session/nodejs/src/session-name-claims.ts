import { InvokeError } from "@telorun/sdk";

export const ERR_SESSION_NAME_DUPLICATE = "ERR_SESSION_NAME_DUPLICATE";

interface Claim {
  readonly owner: object;
  readonly describe: string;
}

/**
 * The names claimed on each store by the session sets bound to it — the runtime
 * twin of the `SESSION_NAME_DUPLICATE` rule. Keyed on the store INSTANCE, so two
 * sets naming one store declaration meet here and two stores never do. It holds
 * this process's own sets only.
 */
const claims = new WeakMap<object, Map<string, Claim>>();

/** Claims `name` on `store` for `owner`; the returned closure releases it. */
export function claimSessionName(store: object, name: string, owner: object, describe: string): () => void {
  let names = claims.get(store);
  if (!names) claims.set(store, (names = new Map()));
  const existing = names.get(name);
  if (existing && existing.owner !== owner) {
    throw new InvokeError(
      ERR_SESSION_NAME_DUPLICATE,
      `${describe} claims the name '${name}' on its store, which ${existing.describe} already claims. ` +
        "Their records would collide and each set's tokens would be accepted by the other's verifier — " +
        "give each set a name of its own.",
      { name },
    );
  }
  names.set(name, { owner, describe });
  return () => {
    if (names.get(name)?.owner === owner) names.delete(name);
  };
}
