/**
 * `matches` — and it is RE2, not the host's regular expressions.
 *
 * CEL's pattern language is RE2: linear-time matching with no backreferences and no
 * lookaround. The host's own engine accepts patterns RE2 refuses and is exponential on
 * some of them, so an expression that matches here would behave differently on another
 * runtime and a hostile pattern in a manifest would be a denial of service. A pattern
 * RE2 cannot parse is `invalid_regular_expression`, never a silent `false`.
 *
 * Compilation is memoized, bounded, because a pattern is almost always a literal
 * evaluated many times.
 */

import { RE2JS } from "re2js";
import { BoundedCache } from "./bounded-cache.js";
import { celError, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/** How many compiled patterns one process keeps. */
export const PATTERN_CACHE_CAPACITY = 128;

const compiled = new BoundedCache<string, RE2JS | string>(PATTERN_CACHE_CAPACITY);

/** Whether the pattern matches anywhere in the text, or why the pattern is not one. */
export function celMatches(text: string, pattern: string, range?: SourceRange): boolean | CelError {
  let held = compiled.get(pattern);
  if (held === undefined) {
    try {
      held = RE2JS.compile(pattern);
    } catch (cause) {
      held = (cause as Error).message;
    }
    compiled.set(pattern, held);
  }
  if (typeof held === "string") {
    return celError(
      "invalid_regular_expression",
      `${JSON.stringify(pattern)} is not an RE2 pattern: ${held}`,
      range,
    );
  }
  return held.matcher(text).find();
}
