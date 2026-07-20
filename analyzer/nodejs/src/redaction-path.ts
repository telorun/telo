/**
 * The redaction path grammar of `kernel/specs/logging.md` §14 — a hand-written
 * parser over a closed grammar.
 *
 * §14.1 makes this a security requirement rather than a style preference. The
 * implementation this syntax is borrowed from compiles paths through the
 * `Function` constructor and validates them by "evaluate it and see whether it
 * parses", which is exactly why that implementation must forbid user input. A
 * real parser removes the injection surface entirely and, as a bonus, makes
 * paths statically checkable by `telo check`.
 *
 * Browser-safe by construction: this module is imported by both the analyzer's
 * static check and the kernel's runtime redaction pass, so the grammar has one
 * definition rather than two that can drift.
 *
 * Grammar:
 *
 *     path     := segment ( "." segment | bracket )*
 *     segment  := bareKey | "*"
 *     bracket  := "[" ( quoted | integer | "*" ) "]"
 *     quoted   := '"' ... '"' | "'" ... "'"
 *
 * More than one wildcard per path is supported — `items[*].tokens[*].value` is
 * valid. The one-wildcard limit in the best-known implementation is an artifact
 * of how it compiles accessors, not a property of the grammar.
 */

export type RedactionSegment = { kind: "key"; name: string } | { kind: "wildcard" };

export class RedactionPathError extends Error {
  readonly code = "INVALID_REDACTION_PATH";
  readonly path: string;
  readonly offset: number;

  constructor(path: string, offset: number, detail: string) {
    super(`Invalid redaction path "${path}" at position ${offset}: ${detail}`);
    this.name = "RedactionPathError";
    this.path = path;
    this.offset = offset;
  }
}

const BARE_KEY_TERMINATORS = new Set([".", "[", "]"]);

/**
 * Parse a redaction path into its segments. Throws {@link RedactionPathError}
 * with the offending offset so `telo check` can point at the character rather
 * than the whole path.
 */
export function parseRedactionPath(path: string): RedactionSegment[] {
  if (path.length === 0) throw new RedactionPathError(path, 0, "path is empty");

  const segments: RedactionSegment[] = [];
  let index = 0;
  let expectSegment = true;

  while (index < path.length) {
    const char = path[index]!;

    if (char === "[") {
      index = parseBracket(path, index, segments);
      expectSegment = false;
      continue;
    }

    if (char === ".") {
      if (expectSegment) {
        throw new RedactionPathError(path, index, "expected a key before '.'");
      }
      index += 1;
      expectSegment = true;
      continue;
    }

    if (char === "]") {
      throw new RedactionPathError(path, index, "unmatched ']'");
    }

    const start = index;
    while (index < path.length && !BARE_KEY_TERMINATORS.has(path[index]!)) index += 1;
    const raw = path.slice(start, index);
    if (raw.length === 0) throw new RedactionPathError(path, start, "empty key");
    segments.push(raw === "*" ? { kind: "wildcard" } : { kind: "key", name: raw });
    expectSegment = false;
  }

  if (expectSegment) {
    throw new RedactionPathError(path, path.length, "path ends with a trailing '.'");
  }
  return segments;
}

function parseBracket(path: string, open: number, segments: RedactionSegment[]): number {
  let index = open + 1;
  if (index >= path.length) throw new RedactionPathError(path, open, "unterminated '['");

  const quote = path[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    const start = index;
    while (index < path.length && path[index] !== quote) index += 1;
    if (index >= path.length) {
      throw new RedactionPathError(path, start, `unterminated ${quote} quoted key`);
    }
    const name = path.slice(start, index);
    if (name.length === 0) throw new RedactionPathError(path, start, "empty quoted key");
    index += 1;
    if (path[index] !== "]") {
      throw new RedactionPathError(path, index, "expected ']' after quoted key");
    }
    segments.push({ kind: "key", name });
    return index + 1;
  }

  const start = index;
  while (index < path.length && path[index] !== "]") index += 1;
  if (index >= path.length) throw new RedactionPathError(path, open, "unterminated '['");
  const raw = path.slice(start, index);
  if (raw.length === 0) throw new RedactionPathError(path, start, "empty '[]'");
  if (raw === "*") {
    segments.push({ kind: "wildcard" });
  } else if (/^\d+$/.test(raw)) {
    segments.push({ kind: "key", name: raw });
  } else {
    throw new RedactionPathError(
      path,
      start,
      `expected a quoted key, an integer index, or '*', got "${raw}" — quote it as ["${raw}"]`,
    );
  }
  return index + 1;
}

/** `true` when the path contains a wildcard anywhere but its last segment.
 *  §14.2 measures intermediate wildcards at 25–55% over plain serialization,
 *  against 1–2% for explicit paths, so a runtime may warn when one is used. */
export function hasIntermediateWildcard(segments: readonly RedactionSegment[]): boolean {
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i]!.kind === "wildcard") return true;
  }
  return false;
}
