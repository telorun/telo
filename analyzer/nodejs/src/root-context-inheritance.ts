/**
 * How a context declared at a schema's root inherits along `extends`. A root
 * `x-telo-context` names what every CEL site of the resource may read, so a
 * merge-form child's is its parent's with its own laid over it, as a nested
 * region adds to an enclosing one: a binding the child declares replaces the
 * parent's of that name whole, and the child's other context keywords win. A
 * `base:` child's author schema is its own, so it inherits none.
 *
 * No imports, because `effectiveAuthorSchema` joins through it and is read by
 * every host.
 */

export const ROOT_CONTEXT_ANNOTATION = "x-telo-context";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * `own` laid over `inherited`. A side that is no object contributes nothing;
 * with no object on either side `own` is returned as written.
 */
export function joinInheritedRootContext(inherited: unknown, own: unknown): unknown {
  if (!isObject(own)) return isObject(inherited) ? inherited : own;
  if (!isObject(inherited)) return own;
  const joined: Record<string, unknown> = { ...inherited, ...own };
  const properties = {
    ...(isObject(inherited.properties) ? inherited.properties : {}),
    ...(isObject(own.properties) ? own.properties : {}),
  };
  if (Object.keys(properties).length > 0) joined.properties = properties;
  return joined;
}

/** `merged` with its root context the join of each schema's in `chain`, the
 *  root-most first. `merged` is returned as it is when none declares one. */
export function withJoinedRootContext(
  merged: Record<string, any>,
  chain: readonly (Record<string, any> | undefined)[],
): Record<string, any> {
  let joined: unknown;
  for (const schema of chain) joined = joinInheritedRootContext(joined, schema?.[ROOT_CONTEXT_ANNOTATION]);
  if (joined !== undefined) merged[ROOT_CONTEXT_ANNOTATION] = joined;
  return merged;
}
