/**
 * The one renderer for AJV validation failures.
 *
 * Browser-safe and re-imported by the kernel — the split `buildEvalPaths` and
 * the redaction path parser already use — so a failure is phrased identically
 * under `telo check` and at runtime. Three implementations used to answer this
 * (the analyzer's keyword prose, the kernel's raw `instancePath + message`
 * join, and observed state's own inline variant), so a developer who fixed what
 * the analyzer told them met a different sentence describing the same thing.
 *
 * It renders findings the judge (`schema-findings-judge.ts`) already decided —
 * each union replaced by what it reports — and decides nothing itself.
 */

import { readValueTypeSlot, schemaPatternRefusal, VALUE_TYPES, valueTypeBoundRefusal, X_TELO_TYPE } from "@telorun/sdk";
import { membersSlotOf, membersValueRefusal } from "./members-value-slot.js";
import { nearestNames } from "./nearest-name.js";
import { describeTeloFormatFailure, TELO_FORMATS, teloFormatFailure } from "./telo-format.js";

/** An AJV error object. Structurally typed — the analyzer and the kernel hand
 *  over errors from their own AJV instances. */
export interface AjvErrorLike {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  params?: Record<string, any>;
  data?: unknown;
  /** The property name a `propertyNames` finding is about. */
  propertyName?: string;
}

/** A schema validation issue with a dotted-path pointer to the offending field. */
export interface SchemaIssue {
  message: string;
  /** Dotted path to the field (e.g. "config.handler"). Empty string means root. */
  path: string;
  /** The same place as a JSON Pointer (RFC 6901), lossless where the dotted
   *  path is not: a key holding `.` or `[`. */
  pointer?: string;
  /** The AJV keyword that produced it, so a consumer can key on WHAT failed
   *  rather than on how the sentence reads. Prose is the renderer's to change;
   *  a caller matching on it breaks silently when it does, and mis-fires on any
   *  other issue whose text happens to quote the same name. */
  keyword?: string;
  /** For `required`, the property that is missing. */
  missingProperty?: string;
  /** For `additionalProperties`, the property that is not allowed. */
  additionalProperty?: string;
  /** For `x-telo-type`, the value type the value failed. */
  valueType?: string;
  /** The message after the pointer it opens with, where it quotes its place —
   *  what a diagnostic renders its message from once its path is where the
   *  value was written. */
  prose?: string;
  /** How many trailing keys of `path` lie beneath the place the message
   *  quotes: the member a `required` issue names. */
  quoteTrail?: number;
  /** The places of the declaration the message writes between backticks, as
   *  written, for a message that quotes no pointer. */
  places?: readonly string[];
}

/** RFC 6901 escapes: `~1` is a literal `/` in the key, `~0` a literal `~`.
 *  Decoded wherever a segment is shown or matched, because encoded it is not the
 *  key the manifest holds — a content map (`application/json`) anchors nowhere
 *  and reads wrong in the sentence. `~0` is expanded LAST, or `~01` would decode
 *  to `/` instead of the literal `~1` it encodes. */
function unescapeSegment(part: string): string {
  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The whole pointer, segment by segment, for prose that quotes it verbatim. */
function unescapePointer(pointer: string): string {
  return pointer
    .split("/")
    .map((segment, i) => (i === 0 ? segment : unescapeSegment(segment)))
    .join("/");
}

/* ------------------------------------------------------------------ prose */

export function formatSingleError(err: AjvErrorLike): string {
  // Unescaped for the same reason the path is: a reader acting on this sentence
  // needs the key the manifest holds (`application/json`), not its RFC 6901
  // encoding. Reporting one form in `path` and the other in `message` made one
  // diagnostic disagree with itself.
  return `${unescapePointer(err.instancePath || "") || "/"} ${errorProse(err)}`;
}

/** What a finding says of the place {@link formatSingleError} opens with. */
function errorProse(err: AjvErrorLike): string {
  const params = err.params ?? {};
  switch (err.keyword) {
    case "additionalProperties":
      return `must NOT have additional properties ('${params.additionalProperty}' is not allowed)`;
    case "required":
      return `is missing required property '${params.missingProperty}'`;
    case "enum": {
      const allowed = (params.allowedValues as unknown[] | undefined) ?? [];
      if (allowed.length <= LISTED_ENUM_VALUES) {
        return `${err.message ?? "is invalid"} (${allowed.join(" | ")})`;
      }
      return `must be one of ${allowed.length} allowed values${suggestedValues(err.data, allowed)}`;
    }
    case "type":
      return `must be ${params.type}${describeActual(err)}`;
    // A `false` schema at a property is how a branch forbids a key it otherwise
    // declares. AJV's own text ("boolean schema is false") describes the schema
    // rather than the value, and the path is the only part a reader can act on.
    case "false schema":
      return "is not allowed here";
    // `not:` says a forbidden shape matched, and AJV reports nothing about the
    // inner schema — so the honest message says where, and no more. A branch
    // that wants to name the key writes `properties: { <key>: false }` instead.
    case "not":
      return "matches a shape that is not allowed here";
    default:
      return err.message ?? "is invalid";
  }
}

/** The most allowed values an enum refusal lists; past it the message says how
 *  many there are and names the nearest instead, since a closed vocabulary of
 *  thousands (an icon set) listed whole buries the one line a reader needs. */
export const LISTED_ENUM_VALUES = 20;

/** The most nearest values one refusal names. */
const SUGGESTED_ENUM_VALUES = 5;

/** `; did you mean 'house'?` — the allowed strings nearest the refused one (the
 *  first few when many tie), or nothing when the value is not a string or none
 *  is near. */
function suggestedValues(value: unknown, allowed: readonly unknown[]): string {
  if (typeof value !== "string") return "";
  const near = nearestNames(
    value,
    allowed.filter((candidate): candidate is string => typeof candidate === "string"),
  ).slice(0, SUGGESTED_ENUM_VALUES);
  return near.length === 0 ? "" : `; did you mean ${near.map((name) => `'${name}'`).join(" or ")}?`;
}

/** ` (got string)`, or nothing when the value is not in hand. AJV carries
 *  `data` only under `verbose`, and a reducer that navigated the root value
 *  would have to be given it at every call site; an absent actual type is worth
 *  less than a wrong one. */
function describeActual(err: AjvErrorLike): string {
  if (!("data" in err)) return "";
  const d = err.data;
  if (d === null) return " (got null)";
  if (Array.isArray(d)) return " (got array)";
  return ` (got ${typeof d})`;
}

/* --------------------------------------------------------------- rendering */

/** Converts an AJV error to a dotted path compatible with PositionIndex keys.
 *  e.g. instancePath "/config/routes/0/handler" → "config.routes[0].handler"
 *  For "required" keyword errors, appends the missing property to the parent path. */
export function ajvErrorToPath(err: AjvErrorLike): string {
  const instancePath = err.instancePath ?? "";
  const parts = instancePath.split("/").filter((p) => p !== "");
  let result = "";
  for (const part of parts) {
    if (/^\d+$/.test(part)) result += `[${part}]`;
    else result += result ? `.${unescapeSegment(part)}` : unescapeSegment(part);
  }
  if (err.keyword === "required" && err.params?.missingProperty) {
    const missing = err.params.missingProperty as string;
    result += result ? `.${missing}` : missing;
  }
  return result;
}

/** {@link ajvErrorToPath}'s place as a JSON Pointer: the instance path, and for
 *  `required` the missing property beneath it. */
function ajvErrorToPointer(err: AjvErrorLike): string {
  const instancePath = err.instancePath ?? "";
  const missing = err.keyword === "required" ? err.params?.missingProperty : undefined;
  if (typeof missing !== "string") return instancePath;
  return `${instancePath}/${missing.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/* ---------------------------------------------------------- telo formats */

/** The value at an AJV `instancePath` under `root`, or undefined. */
function valueAt(root: unknown, instancePath: string | undefined): unknown {
  let current = root;
  for (const segment of (instancePath ?? "").split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[unescapeSegment(segment)];
  }
  return current;
}

/**
 * Replace AJV's `must match format "<name>"` with the checker's reason, for a
 * Telo format. AJV hands a format validator a string and takes back a boolean,
 * so WHY a value failed exists only once the checker is asked again — which
 * needs the value, and AJV's error carries it only under `verbose`. The caller
 * hands over the root it validated instead; without it the text stays AJV's.
 */
export function explainFormatErrors(
  errors: AjvErrorLike[] | null | undefined,
  data: unknown,
): AjvErrorLike[] | null | undefined {
  if (!errors) return errors;
  const explained = errors.map((err) => {
    const name = err.keyword === "format" ? err.params?.format : undefined;
    if (name === "regex") return explainedPattern(err, data, errors);
    if (typeof name !== "string" || !TELO_FORMATS.has(name)) return err;
    const value = valueAt(data, err.instancePath);
    if (typeof value !== "string") return err;
    const failure = teloFormatFailure(name, value);
    return failure ? { ...err, message: describeTeloFormatFailure(name, value, failure) } : err;
  });
  return explained.filter((err) => !restatesExplainedKey(err, explained));
}

/**
 * `format: regex` explained by the schema pattern seam: why RE2 refuses the pattern,
 * `invalid RE2 pattern "<pattern>": <kind>`. A `patternProperties` key is the error's
 * `propertyName`; a pattern value is read from the validated root.
 */
function explainedPattern(err: AjvErrorLike, data: unknown, all: readonly AjvErrorLike[]): AjvErrorLike {
  const pattern = err.propertyName ?? keyOf(err, all) ?? valueAt(data, err.instancePath);
  const refusal = typeof pattern === "string" ? schemaPatternRefusal(pattern) : undefined;
  return refusal ? { ...err, message: refusal } : err;
}

/** The property name a `propertyNames` finding beside `err` names, for a finding
 *  raised under it that does not carry the name itself. */
function keyOf(err: AjvErrorLike, all: readonly AjvErrorLike[]): string | undefined {
  const at = all.indexOf(err);
  const companion = all.slice(at + 1).find((other) => isCompanion(other, err));
  const name = companion?.params?.propertyName;
  return typeof name === "string" ? name : undefined;
}

/** Whether `outer` is the `propertyNames` finding `inner` was raised beneath. */
function isCompanion(outer: AjvErrorLike, inner: AjvErrorLike): boolean {
  return (
    outer !== inner &&
    outer.keyword === "propertyNames" &&
    outer.instancePath === inner.instancePath &&
    (inner.schemaPath ?? "").startsWith(`${outer.schemaPath ?? ""}/`)
  );
}

/** A `propertyNames` finding whose name an explained pattern finding beneath it
 *  already reports at the same place. */
function restatesExplainedKey(err: AjvErrorLike, all: readonly AjvErrorLike[]): boolean {
  if (err.keyword !== "propertyNames") return false;
  const name = err.params?.propertyName;
  return all.some(
    (other) =>
      isCompanion(err, other) &&
      other.keyword === "format" &&
      other.params?.format === "regex" &&
      typeof name === "string" &&
      other.message === schemaPatternRefusal(name),
  );
}

/**
 * Replace the `x-telo-type` keyword's message for a value type that declares members with
 * the REASON the value at its path is not one — the text that does not read, the member
 * that cannot stand, the argument that refuses it — worded without the value. Like a
 * format's reason, it needs the value, which AJV's error carries only under `verbose`; the
 * caller hands over the root it validated, and without it the keyword's text stays.
 */
export function explainValueTypeErrors(
  errors: AjvErrorLike[] | null | undefined,
  data: unknown,
): AjvErrorLike[] | null | undefined {
  if (!errors || data === undefined) return errors;
  return errors.map((err) => {
    if (err.keyword !== X_TELO_TYPE) return err;
    const annotation = err.params?.typeArguments ?? err.params?.valueType;
    const outOfBounds = valueTypeBoundRefusal(
      readValueTypeSlot({ [X_TELO_TYPE]: annotation }),
      valueAt(data, err.instancePath),
    );
    if (outOfBounds) return { ...err, message: outOfBounds };
    const slot = membersSlotOf({ [X_TELO_TYPE]: annotation });
    if (!slot) return err;
    return { ...err, message: `is not a ${slot.entry.name}: ${membersValueRefusal(slot, valueAt(data, err.instancePath))}` };
  });
}

/**
 * The code a finding reports under when it is a value type's own refusal: the
 * `acceptsText.code` of the type whose `x-telo-type` keyword raised it (`URL_INVALID`),
 * or undefined for every other finding. The one reader every site asks — a resource's
 * own field, a call site's `inputs:`, a schema-derived slot, a need supply, a `default:`
 * — so one literal has one code wherever it is written; the kernel's twin is the same
 * code `ERR_`-prefixed.
 */
export function valueTypeRefusalCode(issue: Pick<SchemaIssue, "keyword" | "valueType">): string | undefined {
  if (issue.keyword !== X_TELO_TYPE || !issue.valueType) return undefined;
  return VALUE_TYPES.get(issue.valueType)?.acceptsText?.code;
}

/** An enum refusal carrying the value it refused, read from the validated root
 *  when AJV did not keep it (`verbose` off), so the nearest allowed values can
 *  be named. */
export function withEnumValues(
  errors: AjvErrorLike[] | null | undefined,
  data: unknown,
): AjvErrorLike[] | null | undefined {
  if (!errors || data === undefined) return errors;
  return errors.map((err) =>
    err.keyword === "enum" && !("data" in err) ? { ...err, data: valueAt(data, err.instancePath) } : err,
  );
}

/** Both explanations a refusal can take from the validated value. */
function explained(errors: AjvErrorLike[] | null | undefined, data: unknown): AjvErrorLike[] | null | undefined {
  return explainValueTypeErrors(explainFormatErrors(errors, data), data);
}

/** The judged findings, explained, each enum refusal carrying its value. */
function renderedErrors(findings: AjvErrorLike[] | null | undefined, data: unknown): AjvErrorLike[] {
  return withEnumValues(explained(findings, data), data) ?? [];
}

/** Path-anchored issues over findings the judge stands by — what a diagnostic
 *  list is built from. `data` is the value that was validated, read to explain a
 *  Telo format or a value type's refusal. */
export function schemaIssues(
  findings: AjvErrorLike[] | null | undefined,
  data?: unknown,
): SchemaIssue[] {
  // One finding reached through several union branches sharing a named shape
  // reads identically at one place; it is one finding.
  const seen = new Set<string>();
  return renderedErrors(findings, data).flatMap((err) => {
    const { missingProperty: missing, additionalProperty: extra, valueType } = err.params ?? {};
    const prose = errorProse(err);
    const issue: SchemaIssue = {
      message: formatSingleError(err),
      path: ajvErrorToPath(err),
      pointer: ajvErrorToPointer(err),
      prose,
      quoteTrail: err.keyword === "required" && err.params?.missingProperty ? 1 : 0,
      ...(err.keyword ? { keyword: err.keyword } : {}),
      ...(typeof missing === "string" ? { missingProperty: missing } : {}),
      ...(err.keyword === "additionalProperties" && typeof extra === "string" ? { additionalProperty: extra } : {}),
      ...(typeof valueType === "string" && valueType !== "" ? { valueType } : {}),
    };
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [issue];
  });
}

/** Judged findings rendered as one sentence — what a thrown runtime error carries. */
export function formatAjvErrors(findings: AjvErrorLike[] | null | undefined, data?: unknown): string {
  const rendered = renderedErrors(findings, data);
  if (rendered.length === 0) return "Unknown schema error";
  return [...new Set(rendered.map(formatSingleError))].join("; ");
}
