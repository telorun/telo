/**
 * Where each character of a scalar's PARSED value sits in its RAW source text,
 * so an offset into the value — a CEL hole, an AST node — lands on the
 * characters the author wrote even where the YAML style changed them: a
 * double-quoted escape, a doubled single quote, a block scalar's indentation.
 *
 * Returns `parsed.length + 1` raw offsets (the last one is the value's end), or
 * undefined for a style whose value is not a character-for-character image of
 * its text (a folded block, a multi-line flow scalar), and for any mapping that
 * does not reproduce `parsed` — a caller then falls back rather than pointing at
 * the wrong characters.
 */
export function scalarRawOffsets(
  raw: string,
  style: string | undefined,
  parsed: string,
): number[] | undefined {
  const map =
    style === "QUOTE_DOUBLE"
      ? doubleQuoted(raw)
      : style === "QUOTE_SINGLE"
        ? singleQuoted(raw)
        : style === "BLOCK_LITERAL"
          ? literalBlock(raw, parsed.length)
          : style === "PLAIN" && !/[\r\n]/.test(raw)
            ? [...Array(raw.length + 1).keys()]
            : undefined;
  if (!map || map.length < parsed.length + 1) return undefined;
  const offsets = map.slice(0, parsed.length + 1);
  for (let i = 0; i < parsed.length; i++) {
    const at = raw[offsets[i]!];
    if (at !== "\\" && at !== parsed[i]) return undefined;
  }
  return offsets;
}

function doubleQuoted(raw: string): number[] | undefined {
  const out: number[] = [];
  let j = 1;
  while (j < raw.length - 1) {
    const c = raw[j]!;
    if (c === "\n" || c === "\r") return undefined;
    if (c !== "\\") {
      out.push(j++);
      continue;
    }
    const next = raw[j + 1];
    if (next === undefined || next === "\n" || next === "\r") return undefined;
    const width = next === "x" ? 4 : next === "u" ? 6 : next === "U" ? 10 : 2;
    out.push(j);
    if (next === "U" && parseInt(raw.slice(j + 2, j + 10), 16) > 0xffff) out.push(j);
    j += width;
  }
  out.push(j);
  return out;
}

function singleQuoted(raw: string): number[] | undefined {
  const out: number[] = [];
  let j = 1;
  while (j < raw.length - 1) {
    const c = raw[j]!;
    if (c === "\n" || c === "\r") return undefined;
    out.push(j);
    j += c === "'" && raw[j + 1] === "'" ? 2 : 1;
  }
  out.push(j);
  return out;
}

function literalBlock(raw: string, parsedLength: number): number[] | undefined {
  const firstBreak = raw.indexOf("\n");
  if (firstBreak < 0) return undefined;
  const lines = raw.slice(firstBreak + 1).split("\n");
  const indent = lines.find((l) => l.trim() !== "")?.match(/^ */)?.[0].length ?? 0;
  const out: number[] = [];
  let lineStart = firstBreak + 1;
  for (const line of lines) {
    const content = Math.min(indent, line.length);
    for (let k = content; k < line.length; k++) out.push(lineStart + k);
    out.push(lineStart + line.length);
    lineStart += line.length + 1;
    if (out.length > parsedLength) break;
  }
  return out;
}
