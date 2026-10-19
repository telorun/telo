import { appendBlock } from "./composer";

/**
 * What the user has selected in an editor, carried with their next message.
 *
 * It travels inside the message TEXT, as a fenced ```telo-selection block whose
 * info line names the workspace file and its lines — so every agent reads it as
 * a quoted excerpt and every client shows it as a code block. This file is the
 * block's one writer and one reader; the panel draws a parsed block as a chip.
 */
export interface EditorSelection {
  /** Workspace-relative. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

const LANGUAGE = "telo-selection";
const OPEN_FENCE = /^(`{3,})telo-selection (.+):(\d+)(?:-(\d+))?[ \t]*$/;

/** `file:line` or `file:start-end`. */
export function selectionLabel(selection: EditorSelection): string {
  const lines =
    selection.startLine === selection.endLine ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`;
  return `${selection.file}:${lines}`;
}

/** The block, fenced longer than any run of backticks inside the text. */
export function selectionBlock(selection: EditorSelection): string {
  const longest = Math.max(0, ...(selection.text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${LANGUAGE} ${selectionLabel(selection)}\n${selection.text.replace(/\n+$/, "")}\n${fence}`;
}

export function sameSelection(a: EditorSelection, b: EditorSelection): boolean {
  return a.file === b.file && a.startLine === b.startLine && a.endLine === b.endLine && a.text === b.text;
}

/** What a message carries: the selections already on it, then the live editor
 *  selection unless it is one of them. */
export function carriedSelections(
  carried: readonly EditorSelection[],
  live: EditorSelection | null,
): EditorSelection[] {
  return live && !carried.some((s) => sameSelection(s, live)) ? [...carried, live] : [...carried];
}

/** The selections a stored composer or queued message holds; anything not a
 *  selection is left out. */
export function storedSelections(value: unknown): EditorSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: Partial<EditorSelection> | null) =>
    entry &&
    typeof entry.file === "string" &&
    Number.isInteger(entry.startLine) &&
    Number.isInteger(entry.endLine) &&
    typeof entry.text === "string"
      ? [{ file: entry.file, startLine: entry.startLine!, endLine: entry.endLine!, text: entry.text }]
      : [],
  );
}

/** The message as sent: what was typed, then each selection's block. */
export function withSelections(text: string, selections: readonly EditorSelection[]): string {
  return selections.reduce((message, selection) => appendBlock(message, selectionBlock(selection)), text.trim());
}

/**
 * A user message split into what was typed and the selections it carried. A
 * block with no closing fence is left in the prose, so nothing is hidden.
 */
export function splitUserText(text: string): { prose: string; selections: EditorSelection[] } {
  const lines = text.split("\n");
  const prose: string[] = [];
  const selections: EditorSelection[] = [];
  let run: string[] = [];
  const endRun = () => {
    const part = run.join("\n").trim();
    if (part) prose.push(part);
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_FENCE.exec(lines[i]);
    const close = open ? closingLine(lines, i + 1, open[1].length) : -1;
    if (!open || close === -1) {
      run.push(lines[i]);
      continue;
    }
    endRun();
    const startLine = Number(open[3]);
    selections.push({
      file: open[2],
      startLine,
      endLine: open[4] === undefined ? startLine : Number(open[4]),
      text: lines.slice(i + 1, close).join("\n"),
    });
    i = close;
  }
  endRun();
  return { prose: prose.join("\n\n"), selections };
}

function closingLine(lines: string[], from: number, fenceLength: number): number {
  const closing = new RegExp(`^\`{${fenceLength},}[ \\t]*$`);
  for (let i = from; i < lines.length; i++) if (closing.test(lines[i])) return i;
  return -1;
}
