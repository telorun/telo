import { diffArrays } from "diff";

/**
 * A line diff as data: the lines one text gained and lost against another,
 * grouped into hunks with surrounding context — a unified diff's content
 * without its text rendering.
 */

export type LineOp = "context" | "added" | "removed";

export interface DiffLine {
  op: LineOp;
  text: string;
  /** Set on a text's final line when it does not end in a newline. */
  noNewline?: true;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiffResult {
  comparable: boolean;
  added: number | null;
  removed: number | null;
  hunks: Hunk[] | null;
}

export interface LineDiffOptions {
  contextLines: number;
  /** The most UTF-8 bytes either side may hold. */
  maxInputBytes: number;
  /** The edit distance past which the search for a minimal diff is given up. */
  maxEditLength?: number;
}

/** Past this many edits the comparison stops looking for the smallest diff and
 *  reports the whole differing region as removed and added. Bounds the work at
 *  roughly its square, whatever the inputs — a call is synchronous, so the
 *  worst case has to stay well under a second. */
export const MAX_EDIT_LENGTH = 1024;

const NOT_COMPARABLE: LineDiffResult = { comparable: false, added: null, removed: null, hunks: null };

/**
 * One line as it is compared: its text, and whether a newline ends it. The two
 * together are its identity, so a final line that gains or loses its newline is
 * a changed line.
 */
interface Line {
  text: string;
  terminated: boolean;
}

function linesOf(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  // A text ending in a newline splits into a trailing empty piece, not a line.
  const unterminated = parts.pop()!;
  const lines = parts.map((part) => ({ text: part, terminated: true }));
  if (unterminated !== "") lines.push({ text: unterminated, terminated: false });
  return lines;
}

const sameLine = (a: Line, b: Line): boolean => a.text === b.text && a.terminated === b.terminated;

interface Edit {
  op: LineOp;
  line: Line;
}

/** The edit script turning `before` into `after`: minimal within the edit cap,
 *  otherwise the differing region wholesale. */
function editScript(before: Line[], after: Line[], maxEditLength: number): Edit[] {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && sameLine(before[prefix]!, after[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    sameLine(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)
  ) {
    suffix++;
  }
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);

  const edits: Edit[] = before.slice(0, prefix).map((line) => ({ op: "context", line }));
  const changes = diffArrays(oldMiddle, newMiddle, { comparator: sameLine, maxEditLength });
  if (changes === undefined) {
    for (const line of oldMiddle) edits.push({ op: "removed", line });
    for (const line of newMiddle) edits.push({ op: "added", line });
  } else {
    for (const change of changes) {
      const op: LineOp = change.added ? "added" : change.removed ? "removed" : "context";
      for (const line of change.value) edits.push({ op, line });
    }
  }
  for (const line of before.slice(before.length - suffix)) edits.push({ op: "context", line });
  return edits;
}

const diffLine = ({ op, line }: Edit): DiffLine =>
  line.terminated ? { op, text: line.text } : { op, text: line.text, noNewline: true };

/**
 * Group an edit script into hunks: each run of changes with up to `context`
 * unchanged lines either side, two runs sharing a hunk when the unchanged lines
 * between them would otherwise overlap. Line numbers are 1-based; a side with no
 * lines in a hunk starts at the line before it, 0 at the start of the text.
 */
function hunksOf(edits: Edit[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let index = 0;
  // 1-based numbers of the next line on each side.
  let oldLine = 1;
  let newLine = 1;
  const advance = (edit: Edit): void => {
    if (edit.op !== "added") oldLine++;
    if (edit.op !== "removed") newLine++;
  };

  while (index < edits.length) {
    if (edits[index]!.op === "context") {
      advance(edits[index]!);
      index++;
      continue;
    }
    // A change: open a hunk `context` lines back, and extend it while the next
    // change is within reach of this one's trailing context.
    const start = Math.max(0, index - context);
    const leading = index - start;
    let end = index;
    let scan = index;
    while (scan < edits.length) {
      if (edits[scan]!.op !== "context") end = scan + 1;
      else if (scan - end >= 2 * context) break;
      scan++;
    }
    const stop = Math.min(edits.length, end + context);
    const slice = edits.slice(start, stop);
    const oldLines = slice.filter((e) => e.op !== "added").length;
    const newLines = slice.filter((e) => e.op !== "removed").length;
    const firstOld = oldLine - leading;
    const firstNew = newLine - leading;
    hunks.push({
      oldStart: oldLines === 0 ? firstOld - 1 : firstOld,
      oldLines,
      newStart: newLines === 0 ? firstNew - 1 : firstNew,
      newLines,
      lines: slice.map(diffLine),
    });
    for (let i = index; i < stop; i++) advance(edits[i]!);
    index = stop;
  }
  return hunks;
}

export function lineDiff(before: string, after: string, options: LineDiffOptions): LineDiffResult {
  const { maxInputBytes } = options;
  if (Buffer.byteLength(before, "utf8") > maxInputBytes || Buffer.byteLength(after, "utf8") > maxInputBytes) {
    return NOT_COMPARABLE;
  }
  const edits = editScript(linesOf(before), linesOf(after), options.maxEditLength ?? MAX_EDIT_LENGTH);
  return {
    comparable: true,
    added: edits.filter((e) => e.op === "added").length,
    removed: edits.filter((e) => e.op === "removed").length,
    hunks: hunksOf(edits, options.contextLines),
  };
}
