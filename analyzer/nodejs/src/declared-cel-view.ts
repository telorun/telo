import {
  declaredScalarPaths,
  normalizeDeclaredScalars,
  type DeclaredScalarPath,
} from "./invocation-contract.js";

/**
 * THE CEL VIEW OF A DECLARED VALUE: the value as an expression reads it, each
 * leaf in the representation its kind's schema declares. A YAML number arrives
 * as a double, so without the view `self.factor * 10` over an `integer` field
 * is a `double * int` at run while `telo check` types it `int`.
 *
 * One reader of the declaration, for every site that hands such a value to CEL:
 * the kernel's `self` binding, a loop's binding record and the analyzer's
 * decisions. A value forwarded to a controller is not read through it — a
 * controller receives what the author wrote.
 *
 * Browser-safe.
 */

/** The scalar paths of a kind's effective author schema. */
export function declaredViewPaths(
  schema: Record<string, any> | undefined,
  resolveRef?: (ref: string) => Record<string, any> | undefined,
): readonly DeclaredScalarPath[] {
  return schema ? declaredScalarPaths(schema, resolveRef) : [];
}

/** `value`, written at `keys` of a declaration, in its CEL view. */
export function declaredCelViewAt(
  value: unknown,
  keys: readonly (string | number)[],
  paths: readonly DeclaredScalarPath[],
): unknown {
  const beneath: DeclaredScalarPath[] = [];
  for (const { path, form } of paths) {
    const rest = remainder(path, keys);
    if (rest) beneath.push({ path: ["v", ...rest], form });
  }
  if (beneath.length === 0) return value;
  return (normalizeDeclaredScalars({ v: value }, beneath) as { v: unknown }).v;
}

/** What of `path` lies below `keys`, or undefined when it does not run through them. */
function remainder(path: readonly string[], keys: readonly (string | number)[]): string[] | undefined {
  for (let i = 0; i < keys.length; i++) {
    const segment = path[i];
    const key = keys[i]!;
    if (segment === undefined) return undefined;
    if (typeof key === "number" ? segment !== "[]" : segment !== key && segment !== "*") return undefined;
  }
  return path.slice(keys.length);
}
