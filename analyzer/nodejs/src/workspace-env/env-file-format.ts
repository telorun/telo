/**
 * The env-file format — the one owner of how a `.env` file is read and written.
 *
 * **Reading is `dotenv` 17's, exactly**: the same line expression, the same
 * normalization of line breaks, the same trimming, unquoting and `\n` / `\r`
 * expansion inside double quotes, the later assignment of a key winning. A run,
 * a packaged application and Studio all read through this file, and a value
 * that one of them read differently from the others — or from the `dotenv` a
 * developer's other tools use — is a variable that is set in the file and unset
 * in the run. Browser-safe, which `dotenv` is not.
 *
 * **Writing is three pure edits that touch nothing but the key they name.** Each
 * assignment is reported with its spans in the ORIGINAL text, so an edit
 * replaces one value or removes one assignment's lines and leaves every other
 * byte — comments, blank lines, quoting style, line breaks — as it was. Every
 * edit is checked by reading the result back: one that would change how any
 * other key reads, or would not give the key back the value written, is refused
 * with the reason rather than written.
 */

/** dotenv 17's line expression, with group indices. */
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dgm;

/** What separates a key from its value, as the line expression reads it. */
const SEPARATOR = /^(?:\s*=\s*?|:\s+?)/;

const KEY = /^[\w.-]+$/;

/** A range of UTF-16 offsets into the text an assignment was read from. */
export interface EnvFileSpan {
  readonly start: number;
  readonly end: number;
}

export interface EnvFileAssignment {
  readonly key: string;
  /** The value as `dotenv` reads it. */
  readonly value: string;
  /** The whole assignment: from the start of the line its key is on through the
   *  line break ending the line its value ends on (or the end of the text). */
  readonly span: EnvFileSpan;
  /** The value as written, quotes included; empty, at the place a value would
   *  go, when none is written. */
  readonly valueSpan: EnvFileSpan;
}

/** The result of an edit: the new text, or why the edit cannot be made. */
export type EnvFileEdit = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/**
 * Every assignment in `text`, in order. A key assigned twice appears twice; the
 * later one is the one a reader keeps.
 */
export function parseEnvFile(text: string): EnvFileAssignment[] {
  const { normalized, original } = normalizeLineBreaks(text);
  const assignments: EnvFileAssignment[] = [];
  const line = new RegExp(LINE.source, LINE.flags);
  for (let match = line.exec(normalized); match !== null; match = line.exec(normalized)) {
    const indices = match.indices!;
    const [keyStart, keyEnd] = indices[1]!;
    const raw = match[2] ?? "";
    const value = readValue(raw);

    let valueStart: number;
    let valueEnd: number;
    if (indices[2] && raw.trim() !== "") {
      valueStart = indices[2][0] + (raw.length - raw.trimStart().length);
      valueEnd = indices[2][1] - (raw.length - raw.trimEnd().length);
    } else {
      valueStart = valueEnd = keyEnd + SEPARATOR.exec(normalized.slice(keyEnd))![0].length;
    }

    const lineStart = normalized.lastIndexOf("\n", keyStart - 1) + 1;
    const lineBreak = normalized.indexOf("\n", valueEnd);
    const lineEnd = lineBreak < 0 ? normalized.length : lineBreak + 1;
    assignments.push({
      key: match[1]!,
      value,
      span: { start: original[lineStart]!, end: original[lineEnd]! },
      valueSpan: { start: original[valueStart]!, end: original[valueEnd]! },
    });
  }
  return assignments;
}

/** Each key's value, as `dotenv.parse` returns it. */
export function envFileValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const assignment of parseEnvFile(text)) values[assignment.key] = assignment.value;
  return values;
}

/**
 * `text` as an env-file value the reader gives back unchanged: bare when it
 * holds only characters the reader cannot misread, else single- or
 * backtick-quoted (both read literally), else double-quoted where the reader's
 * `\n` / `\r` expansion finds nothing to expand. Refused, with the reason, when
 * no spelling is exact.
 */
export function spellEnvFileValue(text: string): { readonly spelling: string } | { readonly refused: string } {
  // A line break inside quotes reads back, but not behind the comment marker a
  // template writes every line under, and one spelling serves both.
  if (/[\r\n]/.test(text)) return { refused: "it holds a line break, which has no single-line spelling" };
  if (/^[A-Za-z0-9_\-.,/:@+=%]*$/.test(text)) return { spelling: text };
  if (!text.includes("'")) return { spelling: `'${text}'` };
  if (!text.includes("`")) return { spelling: `\`${text}\`` };
  if (!text.includes('"') && !/\\[nr]/.test(text)) return { spelling: `"${text}"` };
  return {
    refused: text.includes('"')
      ? "it holds all three quote characters, so no quoting reads it back literally"
      : "it holds both other quote characters and a '\\n' or '\\r' that double quotes would expand",
  };
}

/**
 * Set `key` to `value` where the file already assigns it: the value of its LAST
 * assignment — the one a reader keeps — is replaced, and nothing else on that
 * line or in the file moves. A key the file does not assign is refused; adding
 * one is `appendEnvFileValue`.
 */
export function setEnvFileValue(text: string, key: string, value: string): EnvFileEdit {
  const spelled = spellEnvFileValue(value);
  if ("refused" in spelled) return refused(key, spelled.refused);
  const last = parseEnvFile(text).filter((assignment) => assignment.key === key).pop();
  if (!last) return { ok: false, reason: `the file does not assign ${key}` };
  const edited = text.slice(0, last.valueSpan.start) + spelled.spelling + text.slice(last.valueSpan.end);
  return verified(text, edited, key, value);
}

/** Add `KEY=<value>` as a line of its own at the end of the file. */
export function appendEnvFileValue(text: string, key: string, value: string): EnvFileEdit {
  if (!KEY.test(key)) return { ok: false, reason: `'${key}' is not a name an env file can assign` };
  const spelled = spellEnvFileValue(value);
  if ("refused" in spelled) return refused(key, spelled.refused);
  return verified(text, appendEnvFileLines(text, [`${key}=${spelled.spelling}`]), key, value);
}

/** `text` with `lines` added at its end, a line break first when the last line
 *  has none, so the first added line never joins it. */
export function appendEnvFileLines(text: string, lines: readonly string[]): string {
  const base = text === "" || text.endsWith("\n") || text.endsWith("\r") ? text : `${text}\n`;
  return `${base}${lines.map((line) => `${line}\n`).join("")}`;
}

/** Remove every assignment of `key` — each one's whole lines. A file that does
 *  not assign it comes back unchanged. */
export function clearEnvFileValue(text: string, key: string): EnvFileEdit {
  const own = parseEnvFile(text).filter((assignment) => assignment.key === key);
  let edited = text;
  for (const { span } of own.reverse()) edited = edited.slice(0, span.start) + edited.slice(span.end);
  return verified(text, edited, key, undefined);
}

function refused(key: string, reason: string): EnvFileEdit {
  return { ok: false, reason: `the value of ${key} cannot be written to an env file: ${reason}` };
}

/** `edited`, if it reads back as `text` does with only `key` changed — to
 *  `value`, or absent when `value` is `undefined`. */
function verified(text: string, edited: string, key: string, value: string | undefined): EnvFileEdit {
  const before = envFileValues(text);
  const after = envFileValues(edited);
  const others = new Set([...Object.keys(before), ...Object.keys(after)]);
  others.delete(key);
  const moved = [...others].filter((other) => before[other] !== after[other]);
  const unfinished =
    "an assignment in the file is unfinished (an open quote, or a 'KEY:' with no value), " +
    "so the edited line would be read as part of it; finish that assignment first";
  if (moved.length > 0) {
    return { ok: false, reason: `writing ${key} would change how the file reads ${moved.join(", ")}: ${unfinished}` };
  }
  if (after[key] !== value) {
    return {
      ok: false,
      reason:
        value === undefined
          ? `${key} would still read as set after removing its assignments: ${unfinished}`
          : `${key} would not read back as the value written: ${unfinished}`,
    };
  }
  return { ok: true, text: edited };
}

function readValue(raw: string): string {
  let value = raw.trim();
  const quote = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
  if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  return value;
}

/**
 * `text` with every `\r\n` and lone `\r` read as `\n`, as the reader does, plus
 * where each of its offsets — one past the end included — sits in `text`.
 */
function normalizeLineBreaks(text: string): { normalized: string; original: number[] } {
  const original: number[] = [];
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    original.push(i);
    if (text[i] === "\r") {
      normalized += "\n";
      if (text[i + 1] === "\n") i++;
    } else {
      normalized += text[i];
    }
  }
  original.push(text.length);
  return { normalized, original };
}
