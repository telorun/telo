import type { MessageValue } from "@telorun/message-format";
import type { WordCall } from "./ui-error.js";

/** One finding of a refused request: where, under which keyword, with what. */
export interface Issue {
  pointer: string;
  keyword: string;
  params: Readonly<Record<string, unknown>>;
}

/** What a failure's problem body says the renderer reads: its code, its text
 *  for a person, and its findings. */
export interface Problem {
  code?: string;
  detail?: string;
  issues: Issue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isIssue = (value: unknown): value is Issue =>
  isRecord(value) && typeof value.pointer === "string" && typeof value.keyword === "string" && isRecord(value.params);

/** A response body read as a problem; whatever it lacks is absent. */
export function problemOf(body: unknown): Problem {
  const answer = isRecord(body) ? body : {};
  const data = isRecord(answer.data) ? answer.data : {};
  return {
    ...(typeof answer.code === "string" ? { code: answer.code } : {}),
    ...(typeof answer.detail === "string" ? { detail: answer.detail } : {}),
    issues: Array.isArray(data.issues) ? data.issues.filter(isIssue) : [],
  };
}

const shown = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
const listed = (value: unknown): string => [value].flat().map(shown).join(", ");
const scalar = (value: unknown): MessageValue => (typeof value === "number" || typeof value === "string" ? value : shown(value));
const passed = (...names: string[]) => (params: Issue["params"]) =>
  Object.fromEntries(names.filter((name) => params[name] !== undefined).map((name) => [name, scalar(params[name])]));

/**
 * Each keyword of the issue vocabulary as the word it reads as, with the
 * values that word is formatted with: the words the browser's own validation
 * says, so a refusal the server finds reads as one the browser finds.
 */
export const ISSUE_WORDS: Readonly<Record<string, (params: Issue["params"]) => Record<string, MessageValue>>> = {
  type: (params) => ({ types: listed(params.type) }),
  required: passed("missingProperty"),
  additionalProperties: passed("additionalProperty"),
  enum: (params) => ({ allowed: listed(params.allowedValues) }),
  const: (params) => ({ value: JSON.stringify(params.allowedValue) }),
  format: passed("format"),
  minimum: passed("limit"),
  maximum: passed("limit"),
  exclusiveMinimum: passed("limit"),
  exclusiveMaximum: passed("limit"),
  multipleOf: (params) => ({ limit: scalar(params.multipleOf) }),
  minLength: passed("limit"),
  maxLength: passed("limit"),
  minItems: passed("limit"),
  maxItems: passed("limit"),
  minProperties: passed("limit"),
  maxProperties: passed("limit"),
  pattern: passed("pattern"),
  uniqueItems: passed("i", "j"),
  propertyNames: passed("propertyName"),
  invalid: () => ({}),
};

/** The word an issue reads as; a keyword outside the vocabulary is `invalid`. */
export function issueWord(issue: Issue): WordCall {
  const values = Object.hasOwn(ISSUE_WORDS, issue.keyword) ? ISSUE_WORDS[issue.keyword](issue.params) : undefined;
  return values ? { id: issue.keyword, values } : { id: "invalid" };
}

/** A JSON Pointer's segments, unescaped. */
const segments = (pointer: string): string[] =>
  pointer === "" ? [] : pointer.replace(/^\//, "").split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

/** Where in the request an issue is: within the body, the segments after
 *  `/body`; anywhere else, the whole pointer. */
export function issuePlace(issue: Issue): { inBody: boolean; path: string[] } {
  const path = segments(issue.pointer);
  return path[0] === "body" ? { inBody: true, path: path.slice(1) } : { inBody: false, path };
}
