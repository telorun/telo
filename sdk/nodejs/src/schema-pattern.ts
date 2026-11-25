/**
 * The pattern language of a JSON Schema in Telo: RE2, through one seam.
 *
 * Every JSON Schema validator Telo runs reads `pattern`, the keys of
 * `patternProperties` and `format: regex` here — the analyzer's, the kernel's and a
 * module's own (a transport's request validator). A pattern is RE2, the language CEL's
 * `matches` already reads: linear-time, no lookaround, no backreferences, so a pattern
 * in a manifest cannot hang a validation, and a second runtime reads it identically.
 * The host's own regular expressions are never compiled.
 *
 * A match is an unanchored search. The `u` flag a validator passes is accepted and
 * changes nothing — RE2 reads a pattern as Unicode text — and any other flag is
 * refused. A refusal reads `invalid RE2 pattern "<pattern>": <kind>`, the kind being
 * RE2's own parse-error kind.
 *
 * {@link schemaPattern} is an AJV `code.regExp` engine: its `code` is the expression a
 * standalone validator names it by, so a validator compiled to source and loaded again
 * reaches this function through `@telorun/sdk`. Compilation is the CEL engine's one
 * bounded cache.
 */

import { re2Pattern } from "@telorun/cel";

/** A compiled schema pattern: an unanchored search over a text. */
export interface SchemaPatternMatcher {
  test(text: string): boolean;
  toString(): string;
}

/** A pattern the seam refuses; `pointer` is where a schema holds it, when known. */
export class SchemaPatternError extends Error {
  constructor(
    message: string,
    readonly pointer?: string,
  ) {
    super(message);
    this.name = "SchemaPatternError";
  }
}

/** Why `pattern` is not a schema pattern under `flags`, or undefined when it is one. */
export function schemaPatternRefusal(pattern: string, flags = ""): string | undefined {
  for (const flag of flags) {
    if (flag !== "u") return `invalid RE2 pattern "${pattern}": flag "${flag}" is not supported`;
  }
  const held = re2Pattern(pattern);
  if ("refused" in held) {
    return `invalid RE2 pattern "${pattern}": ${held.refused.kind ?? held.refused.message}`;
  }
  return undefined;
}

function compileSchemaPattern(pattern: string, flags = ""): SchemaPatternMatcher {
  const refusal = schemaPatternRefusal(pattern, flags);
  if (refusal !== undefined) throw new SchemaPatternError(refusal);
  const held = re2Pattern(pattern);
  if ("refused" in held) throw new SchemaPatternError(`invalid RE2 pattern "${pattern}": ${held.refused.message}`);
  const compiled = held.pattern;
  return {
    test: (text: string) => compiled.matcher(text).find(),
    // A validator keys the patterns one schema compiles by this text.
    toString: () => `re2:${flags}:${pattern}`,
  };
}

/** The schema pattern seam, in the shape AJV's `code.regExp` takes. */
export const schemaPattern: ((pattern: string, flags?: string) => SchemaPatternMatcher) & { readonly code: string } =
  Object.assign(compileSchemaPattern, { code: 'require("@telorun/sdk").schemaPattern' });

/** `format: regex` as the seam reads it: a schema pattern RE2 accepts. A validator's
 *  message for a refused value stays its own `must match format "regex"`. */
export const SCHEMA_REGEX_FORMAT = {
  type: "string",
  validate: (value: string): boolean => schemaPatternRefusal(value) === undefined,
} as const;
