/**
 * Instance → the contract paths its kind marked `x-telo-sensitive`, recorded at
 * `create()` beside the handle and the declaration.
 *
 * The trace site has only the instance. It cannot re-derive this: the resolved
 * contract is compiled inside `bindContract`'s closure and dropped, the
 * definition carries the DECLARATION rather than the resolved schema, and an
 * instance-manifest override would be missed by re-resolving from the kind. So
 * the answer is recorded where both halves are in hand, exactly as
 * `instance-declaration.ts` records the other direction.
 *
 * TWO entries per instance, kept apart by direction, because a contract may mark
 * a field on the way in as well as on the way out — `forceRefresh` going to a
 * credential is not sensitive, but a signing key handed to one would be, and a
 * single merged list would redact an input path in an output payload where it
 * names something else entirely.
 *
 * Weak and one-way: paths are obtainable FROM an instance, never an instance
 * from paths, so nothing here extends a lifetime or hands out live state.
 * Resolution is LAZY — the paths are read through a thunk rather than eagerly,
 * because compiling a contract at create time would make every contract-bearing
 * kind depend on type-registration order, which is the reason the binding defers
 * it in the first place.
 */

export type ContractDirection = "inputType" | "outputType";

interface SensitiveThunks {
  inputType?: () => string[][];
  outputType?: () => string[][];
}

const sensitive = new WeakMap<object, SensitiveThunks>();

/** Record how to obtain one direction's sensitive paths for a live instance.
 *  First record wins, matching the handle and declaration rules: a `base:` child
 *  IS its parent instance, and the parent's binding is the one that produced
 *  it. */
export function recordSensitivePaths(
  instance: object,
  direction: ContractDirection,
  paths: () => string[][],
): void {
  const entry = sensitive.get(instance) ?? {};
  if (entry[direction] !== undefined) return;
  entry[direction] = paths;
  sensitive.set(instance, entry);
}

/**
 * The paths one direction of a live instance's contract marked sensitive.
 *
 * An EMPTY list means the contract marked nothing, or the kind declares no
 * contract at all — carry the payload verbatim. `undefined` means the contract
 * could not be resolved, so WHICH fields are sensitive is unknown and the
 * payload must be withheld whole.
 *
 * Nothing is swallowed by that: resolving is exactly what the dispatch about to
 * follow does, so the same failure surfaces from it a moment later, with its own
 * code and its own message. What the catch avoids is a trace site becoming the
 * place an unrelated contract defect first appears — and, far worse, emitting
 * auth material onto the wire because a schema failed to compile.
 */
export function sensitivePathsOfInstance(
  instance: unknown,
  direction: ContractDirection,
): string[][] | undefined {
  if (!instance || typeof instance !== "object") return [];
  const thunk = sensitive.get(instance as object)?.[direction];
  if (!thunk) return [];
  try {
    return thunk();
  } catch {
    return undefined;
  }
}

/** What a hidden value reads as. The key is KEPT and only the value replaced,
 *  per the logging spec §14: a payload that silently loses a key reads as a
 *  value that was never produced. */
export const REDACTED = "[redacted]";

/**
 * `value` with the marked paths replaced by {@link REDACTED}.
 *
 * Copy-on-write ALONG THE PATHS ONLY, so the caller's own object — the very
 * object being handed to a controller, or the one it just returned — is never
 * mutated. A whole-payload clone would be the obvious alternative and is wrong
 * twice: it costs a deep copy per span on the dispatch path, and it would
 * rewrite live values (a stream handle, a resource instance) that only survive
 * by identity.
 */
export function redactSensitive(value: unknown, paths: readonly string[][]): unknown {
  if (paths.length === 0) return value;
  let out = value;
  for (const path of paths) out = redactAt(out, path, 0);
  return out;
}

function redactAt(node: unknown, path: readonly string[], index: number): unknown {
  if (node === null || node === undefined) return node;
  if (index === path.length) return REDACTED;
  const segment = path[index];
  if (segment === "[]") {
    return Array.isArray(node) ? node.map((element) => redactAt(element, path, index + 1)) : node;
  }
  // The map-value wildcard: every own key, whatever it is named. What
  // `additionalProperties` / `patternProperties` emit, since neither carries
  // property names to walk.
  if (segment === "{}") {
    if (typeof node !== "object" || Array.isArray(node)) return node;
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) out[key] = redactAt(value, path, index + 1);
    return out;
  }
  if (typeof node !== "object" || Array.isArray(node)) return node;
  const object = node as Record<string, unknown>;
  // A path the value does not carry is not a defect — the contract describes
  // what MAY be there, and an optional field is routinely absent.
  if (!(segment in object)) return node;
  return { ...object, [segment]: redactAt(object[segment], path, index + 1) };
}
