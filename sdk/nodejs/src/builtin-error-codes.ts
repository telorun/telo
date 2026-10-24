/**
 * The built-in error codes — the ambient codes the runtime raises around every
 * dispatch alike (`contract-errors.ts`) — each with its display message, the
 * text a person is shown for it, written in English. The entries are data, `sdk/error-codes/*.json`
 * (see the README there), copied in by the root `prepare`; the Rust kernel reads
 * the same files.
 *
 * A kernel attaches an entry's display message to an ambient error that leaves
 * a dispatch carrying none, so every failure a person can be shown has words,
 * and a translator catalog may translate them.
 */
import { readText } from "@telorun/message-format";
import { AMBIENT_CONTRACT_ERROR_CODES } from "./contract-errors.js";
import { ERROR_CODE_ENTRY_FILES } from "./error-codes/entries/index.js";
import type { TextRecord } from "./text-record.js";

/** The language every built-in display message is written in. */
export const BUILTIN_ERROR_TEXT_LANG = "en";

export interface BuiltinErrorCode {
  readonly code: string;
  readonly description: string;
  /** The display message as written: a Message, or `{ text, context }`. */
  readonly displayMessage: unknown;
  /** JSON Schema of the error's `data`, when the entry declares one. */
  readonly data?: Record<string, unknown>;
  /** The display message as the record a controller and a renderer receive. */
  readonly record: TextRecord;
}

function readEntry(file: string, raw: unknown): BuiltinErrorCode {
  const entry = raw as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new Error(`The built-in error code entry '${file}' is malformed: ${why}.`);
  };
  if (typeof entry.code !== "string") fail("it declares no `code`");
  if (typeof entry.description !== "string") fail("it declares no `description`");
  const written = entry.displayMessage;
  const read = readText(written);
  if (!read.ok) fail(`its \`displayMessage\` is no text (${read.problems.map((p) => p.message).join("; ")})`);
  const objectForm = !!written && typeof written === "object" && "text" in (written as object);
  const record: TextRecord = {
    text: (objectForm ? (written as { text: unknown }).text : written) as TextRecord["text"],
    context: objectForm ? ((written as { context?: string }).context ?? null) : null,
    lang: BUILTIN_ERROR_TEXT_LANG,
    computed: false,
  };
  return {
    code: entry.code as string,
    description: entry.description as string,
    displayMessage: written,
    ...(entry.data && typeof entry.data === "object" ? { data: entry.data as Record<string, unknown> } : {}),
    record,
  };
}

const ENTRIES: ReadonlyMap<string, BuiltinErrorCode> = new Map(
  ERROR_CODE_ENTRY_FILES.map(([file, raw]) => {
    const entry = readEntry(file, raw);
    return [entry.code, entry] as const;
  }),
);

for (const code of AMBIENT_CONTRACT_ERROR_CODES) {
  if (!ENTRIES.has(code)) {
    throw new Error(
      `The ambient error code '${code}' has no built-in entry: \`sdk/error-codes/${code}.json\` did not reach ` +
        `this build (the root \`prepare\` copies it in).`,
    );
  }
}

/** Every built-in error code, in lexical order. */
export function builtinErrorCodes(): readonly BuiltinErrorCode[] {
  return [...ENTRIES.values()];
}

/** The built-in entry of `code`, or undefined for a code that is not built in. */
export function builtinErrorCode(code: string): BuiltinErrorCode | undefined {
  return ENTRIES.get(code);
}
