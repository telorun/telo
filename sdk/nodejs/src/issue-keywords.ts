/**
 * The issue keywords — the closed vocabulary a finding about a refused value is
 * written in. A finding is `{ pointer, keyword, params }`: a JSON Pointer into
 * the value, the keyword violated, and the facts a reader words it from; it
 * carries no prose. The entries are data, `sdk/issue-keywords/*.json` (see the
 * README there), copied in by the root `prepare`.
 */
import { ISSUE_KEYWORD_ENTRY_FILES } from "./issue-keywords/entries/index.js";

/** The keyword every finding outside the vocabulary is written under. */
export const INVALID_ISSUE_KEYWORD = "invalid";

export interface IssueKeyword {
  readonly keyword: string;
  /** The names of the facts a finding under this keyword carries. */
  readonly params: readonly string[];
}

/** One finding about a refused value. */
export interface ValueIssue {
  /** RFC 6901 JSON Pointer to the value the finding is about. */
  readonly pointer: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function readEntry(file: string, raw: unknown): IssueKeyword {
  const entry = raw as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new Error(`The issue keyword entry '${file}' is malformed: ${why}.`);
  };
  if (typeof entry.keyword !== "string") fail("it declares no `keyword`");
  if (!Array.isArray(entry.params) || entry.params.some((name) => typeof name !== "string")) {
    fail("its `params` is not a list of names");
  }
  return { keyword: entry.keyword as string, params: entry.params as string[] };
}

const ENTRIES: ReadonlyMap<string, IssueKeyword> = new Map(
  ISSUE_KEYWORD_ENTRY_FILES.map(([file, raw]) => {
    const entry = readEntry(file, raw);
    return [entry.keyword, entry] as const;
  }),
);

if (!ENTRIES.has(INVALID_ISSUE_KEYWORD)) {
  throw new Error(
    `The issue keyword '${INVALID_ISSUE_KEYWORD}' has no entry: \`sdk/issue-keywords/${INVALID_ISSUE_KEYWORD}.json\` ` +
      `did not reach this build (the root \`prepare\` copies it in).`,
  );
}

/** Every issue keyword, in lexical order. */
export function issueKeywords(): readonly IssueKeyword[] {
  return [...ENTRIES.values()];
}

/**
 * A finding in the vocabulary: `keyword` and the params its entry names, each
 * one `params` holds; a keyword outside the vocabulary is `invalid`, with none.
 */
export function valueIssue(
  pointer: string,
  keyword: string | undefined,
  params?: Readonly<Record<string, unknown>>,
): ValueIssue {
  const entry = keyword === undefined ? undefined : ENTRIES.get(keyword);
  if (!entry) return { pointer, keyword: INVALID_ISSUE_KEYWORD, params: {} };
  const picked: Record<string, unknown> = {};
  for (const name of entry.params) {
    if (params && Object.hasOwn(params, name) && params[name] !== undefined) picked[name] = params[name];
  }
  return { pointer, keyword: entry.keyword, params: picked };
}

/** `segment` escaped for a JSON Pointer (RFC 6901). */
export function jsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
