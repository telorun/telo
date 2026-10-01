// The server's item grammar: a heading or list-item line whose first word,
// optionally bold, is capital letters followed by digits (`## S1 …`,
// `- **C2**: …`, `3. AB12 …`). The server's list stays authoritative; this only
// locates the lines an ID was declared on.
const ITEM_LINE =
  /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|[0-9]+[.)][ \t]+)(?:\*\*)?([A-Z]+[0-9]+)(?:\*\*)?(?:[ \t:.,)]|$)/;
const HEADING_LINE = /^[ \t]*#{1,6}(?:[ \t]|$)/;

export function itemIdOfLine(line: string): string | undefined {
  return ITEM_LINE.exec(line)?.[1];
}

export function bodyLines(body: string): string[] {
  return body.split(/\r?\n/);
}

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Per line, whether it belongs to a fenced code block (the fence lines
 *  included), by the server's rule: a fence opens at a line starting, after any
 *  indent, with three or more backticks (and no backtick after them) or tildes,
 *  and runs through the next line holding only at least as many of the same
 *  character — at least six for a longer opening — or to the end of the body.
 *  Such a line is never an item. */
export function fencedLines(lines: readonly string[]): boolean[] {
  let closing: RegExp | undefined;
  return lines.map((line) => {
    if (closing) {
      if (closing.test(line)) closing = undefined;
      return true;
    }
    const open = FENCE_OPEN.exec(line);
    if (!open) return false;
    const mark = open[1][0];
    if (mark === "`" && open[2].includes("`")) return false;
    closing = new RegExp(`^[ \\t]*${mark}{${Math.min(open[1].length, 6)},}[ \\t]*$`);
    return true;
  });
}

/** The item ID each line declares, by 0-based line index. */
export function itemIdsByLine(lines: readonly string[]): (string | undefined)[] {
  const fenced = fencedLines(lines);
  return lines.map((line, index) => (fenced[index] ? undefined : itemIdOfLine(line)));
}

/** Each item's text: its own line through the line before the next item or
 *  heading, trailing blank lines dropped. The first declaration of an ID wins. */
export function itemBlocks(body: string): Map<string, string> {
  const lines = bodyLines(body);
  const fenced = fencedLines(lines);
  const blocks = new Map<string, string>();
  let current: { id: string; lines: string[] } | undefined;
  const close = () => {
    if (!current || blocks.has(current.id)) return;
    const kept = [...current.lines];
    while (kept.length > 1 && kept[kept.length - 1].trim() === "") kept.pop();
    blocks.set(current.id, kept.join("\n"));
  };
  lines.forEach((line, index) => {
    const id = fenced[index] ? undefined : itemIdOfLine(line);
    if (id !== undefined || (!fenced[index] && HEADING_LINE.test(line))) {
      close();
      current = id === undefined ? undefined : { id, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  });
  close();
  return blocks;
}
