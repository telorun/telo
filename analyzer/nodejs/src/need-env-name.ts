/**
 * The environment variable one field of a need is read from when the need
 * reaches the root unsupplied and the root binds no name for it:
 * `TELO_NEED_`, then each segment of the need path and the field, each written
 * in upper case with `_` at its word boundaries, joined by `__`.
 *
 * `Orders.databaseAccess` field `url` → `TELO_NEED_ORDERS__DATABASE_ACCESS__URL`.
 *
 * A word boundary is before an uppercase letter that follows a lowercase letter
 * or a digit, and before the last uppercase letter of an uppercase run that a
 * lowercase letter follows — `HTTPServer` is `HTTP_SERVER`, `SQL` stays `SQL`.
 * Two names this maps to one string are refused as `NEED_ENV_NAME_COLLISION`.
 *
 * Browser-safe.
 */

export const NEED_ENV_PREFIX = "TELO_NEED_";

const isUpper = (c: string | undefined): boolean => c !== undefined && c >= "A" && c <= "Z";
const isLower = (c: string | undefined): boolean => c !== undefined && c >= "a" && c <= "z";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** One name as an environment-variable segment. */
export function envNameSegment(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (i > 0 && isUpper(c)) {
      const prev = name[i - 1];
      const next = name[i + 1];
      if (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next))) out += "_";
    }
    out += c.toUpperCase();
  }
  return out;
}

/** The derived environment name of `field` of the need at `path`. */
export function derivedNeedEnvName(path: readonly string[], field: string): string {
  return NEED_ENV_PREFIX + [...path, field].map(envNameSegment).join("__");
}
