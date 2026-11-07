import { quotedLiteralEnd } from "@telorun/cel";

/** One `${{ expr }}` hole in a scalar. Offsets index the scalar's source. */
export interface InterpolationHole {
  /** Offset of the opening `${{`. */
  readonly start: number;
  /** Offset just past the closing `}}`. */
  readonly end: number;
  /** The expression, trimmed of the whitespace inside the delimiters. */
  readonly expr: string;
  /** Offset of {@link expr} within the source. */
  readonly exprStart: number;
}

export type HoleReading =
  | { readonly ok: true; readonly holes: readonly InterpolationHole[] }
  | { readonly ok: false; readonly offset: number; readonly message: string };

/** How a scalar's text relates to holes: none at all, exactly one hole with only
 *  whitespace around it, holes among text, or a `${{` that opens no readable
 *  hole. */
export type InterpolationShape = "none" | "lone-hole" | "interpolated" | "malformed";

const OPEN = "${{";

/**
 * Every `${{ expr }}` hole in `source` — the one hole grammar every tag with
 * holes (`!interpolate`, `!sql`) and the untagged-interpolation migration read.
 *
 * A hole opens at `${{` and closes at the first `}}` that is outside a quoted
 * literal and outside any `{` the expression itself opened, so a map literal or a
 * string holding braces is read whole. A quoted literal ends exactly where the
 * language ends it: the hole reader has no rule of its own and asks the engine
 * (`quotedLiteralEnd`), which reads string and bytes literals, their prefixes and
 * triple-quoted forms, and backtick-quoted member names. A comment is not read, so
 * `//` is hole text and a quote after it opens a literal. Outside a hole nothing is
 * special but `${{`; a literal `${{` is written as a hole yielding it (`${{ '${{' }}`).
 *
 * A hole that never closes is a reading failure at its opening offset, never a
 * guess at where it meant to end.
 */
export function readInterpolationHoles(source: string): HoleReading {
  const holes: InterpolationHole[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(OPEN, from);
    if (start === -1) return { ok: true, holes };
    const close = closingOffset(source, start + OPEN.length);
    if (close === undefined) {
      return {
        ok: false,
        offset: start,
        message: `the hole opened at offset ${start} never closes — a hole ends at the first '}}' outside a string literal and outside any braces it opened`,
      };
    }
    const body = source.slice(start + OPEN.length, close);
    const lead = body.length - body.trimStart().length;
    holes.push({
      start,
      end: close + 2,
      expr: body.trim(),
      exprStart: start + OPEN.length + lead,
    });
    from = close + 2;
  }
}

/** The shape of `source` under {@link readInterpolationHoles}. */
export function interpolationShape(source: string): InterpolationShape {
  if (!source.includes(OPEN)) return "none";
  const reading = readInterpolationHoles(source);
  if (!reading.ok) return "malformed";
  const [only, ...rest] = reading.holes;
  if (!only) return "none";
  const lone =
    rest.length === 0 &&
    source.slice(0, only.start).trim() === "" &&
    source.slice(only.end).trim() === "";
  return lone ? "lone-hole" : "interpolated";
}

/** The literal text between holes: always `holes.length + 1` fragments. */
export function literalFragments(source: string, holes: readonly InterpolationHole[]): string[] {
  const out: string[] = [];
  let last = 0;
  for (const hole of holes) {
    out.push(source.slice(last, hole.start));
    last = hole.end;
  }
  out.push(source.slice(last));
  return out;
}

/** Offset of the `}}` closing a hole whose body starts at `from`. */
function closingOffset(source: string, from: number): number | undefined {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "'" || c === '"' || c === "`") {
      const after = quotedLiteralEnd(source, i);
      if (after === undefined) return undefined;
      i = after;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return source[i + 1] === "}" ? i : undefined;
      depth--;
    }
    i++;
  }
  return undefined;
}
