/**
 * Where each character of a scalar's PARSED value sits in its RAW source text,
 * so an offset into the value — a CEL hole, an AST node — lands on the
 * characters the author wrote even where the YAML style changed them: a
 * double-quoted escape, a doubled single quote, a block scalar's indentation, a
 * line break folded into a space.
 *
 * Returns `parsed.length + 1` raw offsets (the last one is the value's end), or
 * undefined when the text does not align with `parsed` — a caller then falls
 * back rather than pointing at the wrong characters.
 *
 * Every non-whitespace character maps exactly. Whitespace the parsed value
 * holds maps onto whitespace that was written, not necessarily the same
 * character (a folded break, an indented line), and the first whitespace after
 * a character always maps right after it — so a range ending there is exact.
 */
export function scalarRawOffsets(
  raw: string,
  style: string | undefined,
  parsed: string,
): number[] | undefined {
  const start = contentStart(raw, style);
  if (start === undefined) return undefined;
  const quote = style === "QUOTE_DOUBLE" ? '"' : style === "QUOTE_SINGLE" ? "'" : undefined;
  const out: number[] = [];
  let j = start;
  let p = 0;
  while (p < parsed.length) {
    const r = raw[j];
    const c = parsed[p]!;
    if (r === undefined) return undefined;
    if (quote === '"' && r === "\\") {
      const next = raw[j + 1];
      if (next === undefined) return undefined;
      // An escaped line break joins the lines and contributes nothing.
      if (next === "\n" || next === "\r") {
        j += 2;
        continue;
      }
      const width = next === "x" ? 4 : next === "u" ? 6 : next === "U" ? 10 : 2;
      out.push(j);
      p++;
      if (next === "U" && parseInt(raw.slice(j + 2, j + 10), 16) > 0xffff) {
        out.push(j);
        p++;
      }
      j += width;
      continue;
    }
    if (quote === "'" && r === "'") {
      if (c !== "'" || raw[j + 1] !== "'") return undefined;
      out.push(j);
      p++;
      j += 2;
      continue;
    }
    if (r === c) {
      out.push(j++);
      p++;
      continue;
    }
    if (!isBlank(r)) return undefined;
    // A folded break or the indentation around one: whitespace in the value
    // takes the written whitespace's place, anything else skips past it.
    if (isBlank(c)) {
      out.push(j);
      p++;
    }
    j++;
  }
  out.push(j);
  return out;
}

/** Where the value's first character may be written: past the opening quote,
 *  or past a block scalar's header line. */
function contentStart(raw: string, style: string | undefined): number | undefined {
  switch (style) {
    case "QUOTE_DOUBLE":
    case "QUOTE_SINGLE":
      return 1;
    case "PLAIN":
      return 0;
    case "BLOCK_LITERAL":
    case "BLOCK_FOLDED": {
      const firstBreak = raw.indexOf("\n");
      return firstBreak < 0 ? undefined : firstBreak + 1;
    }
    default:
      return undefined;
  }
}

function isBlank(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}
