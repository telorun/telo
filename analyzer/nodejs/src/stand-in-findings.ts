/**
 * What schema validation may say about a value that is not there yet.
 *
 * Before validation every expression is replaced by a STAND-IN — a placeholder
 * shaped so the schema can be run over the rest of the value. A stand-in is not
 * what the author wrote, so a finding about it is a finding about the checker's
 * own placeholder. Two classes, by what the tag guarantees:
 *
 * - **computed** — a `!cel` value (or any tag whose produced type the engine
 *   leaves to the slot): its type is the expression's, so the stand-in says
 *   nothing at all, and every finding at or below it is dropped.
 * - **produced** — a tag whose engine declares a fixed produced type and whose
 *   value exists only after load (`!interpolate`, an embed, a module path): the
 *   stand-in IS that type, so a type, shape or value-type finding stands, while a
 *   value constraint (`pattern`, `minLength`, `format`, …) is judged on text that
 *   does not exist yet and is dropped.
 *
 * A tag the engine resolves to a plain value at compile time is not a stand-in:
 * the value is known, and it is judged like any literal.
 *
 * The filter runs on RAW validator errors, before union reduction collapses them
 * into issues, because a union is judged per branch: one whose branch failed only
 * on findings a stand-in excuses is satisfied, and its errors go with it. Shared
 * by every analyzer substitution site and by the kernel's create-time validation,
 * so `telo check` and the runtime excuse exactly the same findings.
 */

import { isCompiledValue } from "@telorun/sdk";
import {
  defaultRegistry,
  isRefSentinel,
  isTaggedSentinel,
  producedTypeOf,
} from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";
import type { AjvErrorLike } from "./schema-error-report.js";

export type StandInClass = "computed" | "produced";

/** Every stand-in substituted into one value, keyed by its JSON Pointer from the
 *  validated root — the form an AJV `instancePath` takes. */
export type StandIns = Map<string, StandInClass>;

/** What a tagged or compiled value is to validation: a stand-in of a class (with
 *  the produced type, for a produced one), or the plain value its engine already
 *  resolved it to. */
export type StandInReading =
  | { readonly kind: "stand-in"; readonly class: "computed" }
  | { readonly kind: "stand-in"; readonly class: "produced"; readonly produced: Record<string, any> }
  | { readonly kind: "value"; readonly value: unknown };

let compileEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/**
 * Classify a tagged sentinel or a compiled value, or undefined for anything else
 * (a `!ref` is an identity marker, never a stand-in).
 *
 * Read off the engine's compile contract, never off a tag name: an engine whose
 * scalar holds CEL defers to evaluation by construction, and any other engine is
 * asked to compile — a plain result is a value resolved now (`!literal`), a
 * marker or compiled value is one that exists only after load. The class is then
 * whether the engine declares a produced type.
 */
export function readStandIn(value: unknown): StandInReading | undefined {
  let engineName: string | undefined;
  if (isCompiledValue(value)) {
    const engine = (value as { engine?: unknown }).engine;
    engineName = typeof engine === "string" ? engine : undefined;
  } else if (isTaggedSentinel(value)) {
    if (isRefSentinel(value)) return undefined;
    engineName = value.engine;
    const engine = defaultRegistry().get(value.engine);
    if (engine && !engine.expressionRegions) {
      compileEnv ??= buildCelEnvironment();
      const compiled = engine.compile(value.source, { celEnv: compileEnv });
      if (!isCompiledValue(compiled) && !isTaggedSentinel(compiled)) {
        return { kind: "value", value: compiled };
      }
    }
  } else {
    return undefined;
  }
  const produced = engineName === undefined ? undefined : producedTypeOf(engineName);
  return produced
    ? { kind: "stand-in", class: "produced", produced: produced as Record<string, any> }
    : { kind: "stand-in", class: "computed" };
}

/** Findings judged on a value's CONTENT, which a produced stand-in does not have
 *  yet. Closed: anything else — `type`, `required`, `additionalProperties`,
 *  `x-telo-type`, `not` — is about what the tag guarantees, and stands. */
const VALUE_CONSTRAINT_KEYWORDS: ReadonlySet<string> = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
]);

const UNION_KEYWORDS: ReadonlySet<string> = new Set(["anyOf", "oneOf"]);

/** A `oneOf` that failed because SEVERAL branches matched: which one a value
 *  takes is decided by its content, so it is value-level. */
function isAmbiguousOneOf(error: AjvErrorLike): boolean {
  return error.keyword === "oneOf" && Array.isArray(error.params?.passingSchemas);
}

function isUnionFailure(error: AjvErrorLike): boolean {
  return UNION_KEYWORDS.has(error.keyword ?? "") && !isAmbiguousOneOf(error);
}

function isAtOrUnder(path: string, ancestor: string): boolean {
  return ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** True when a stand-in excuses this finding: it sits at or below a computed
 *  stand-in, or at or below a produced one and is judged on content. */
function excused(error: AjvErrorLike, standIns: ReadonlyMap<string, StandInClass>): boolean {
  const valueLevel = VALUE_CONSTRAINT_KEYWORDS.has(error.keyword ?? "") || isAmbiguousOneOf(error);
  let path: string | undefined = error.instancePath ?? "";
  while (path !== undefined) {
    const standIn = standIns.get(path);
    if (standIn === "computed" || (standIn === "produced" && valueLevel)) return true;
    path = path === "" ? undefined : path.slice(0, Math.max(0, path.lastIndexOf("/")));
  }
  return false;
}

function segments(schemaPath: string): string[] {
  return schemaPath.split("/");
}

/**
 * Whether an error raised before a union's own error belongs to it.
 *
 * AJV reports a union's branch errors contiguously, immediately before the
 * union's error. A branch written inline is reported under the union's
 * `schemaPath`; one written as a `$ref` under the target's — another document, or
 * a `$defs` / `definitions` entry. Anything else at the same value node is a
 * sibling keyword evaluated before the union began, and ends its run.
 */
function ownedBy(error: AjvErrorLike, union: AjvErrorLike): boolean {
  if (!isAtOrUnder(error.instancePath ?? "", union.instancePath ?? "")) return false;
  const unionPath = union.schemaPath ?? "";
  const path = error.schemaPath ?? "";
  if (path.startsWith(`${unionPath}/`)) return true;
  if (path.startsWith("#") !== unionPath.startsWith("#")) return true;
  const a = segments(path);
  const b = segments(unionPath);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  if (common === 0) return true;
  const next = a[common];
  return next === "$defs" || next === "definitions";
}

/** The branch index an error sits under, when it is reported under the union's
 *  own `schemaPath`. */
function branchIndexOf(error: AjvErrorLike, union: AjvErrorLike): number | undefined {
  const prefix = `${union.schemaPath ?? ""}/`;
  const path = error.schemaPath ?? "";
  if (!path.startsWith(prefix)) return undefined;
  const index = Number(path.slice(prefix.length).split("/")[0]);
  return Number.isInteger(index) ? index : undefined;
}

/**
 * Drop every finding a stand-in excuses, judging each failed union per branch.
 *
 * A union is satisfied when one of its branches failed only on excused findings;
 * then the union's error and every error its branches raised are dropped. Errors
 * from a `$ref` branch carry no branch index, so consecutive ones are judged as
 * one branch — which can only keep a finding, never drop one a single branch
 * would have kept.
 */
export function withoutStandInFindings<E extends AjvErrorLike>(
  errors: readonly E[] | null | undefined,
  standIns: ReadonlyMap<string, StandInClass>,
): E[] {
  if (!errors || errors.length === 0) return [];
  if (standIns.size === 0) return [...errors];
  const live: (E | undefined)[] = [...errors];
  for (let k = 0; k < live.length; k++) {
    const union = live[k];
    if (!union || !(isUnionFailure(union) || isAmbiguousOneOf(union))) continue;
    const owned: number[] = [];
    for (let j = k - 1; j >= 0; j--) {
      const candidate = live[j];
      if (!candidate) continue;
      if (!ownedBy(candidate, union)) break;
      owned.unshift(j);
    }
    let satisfied: boolean;
    if (isAmbiguousOneOf(union)) {
      satisfied = excused(union, standIns);
    } else {
      const branches: number[][] = [];
      let unindexed: number[] | undefined;
      const byIndex = new Map<number, number[]>();
      for (const j of owned) {
        const index = branchIndexOf(live[j]!, union);
        if (index === undefined) {
          if (!unindexed) branches.push((unindexed = []));
          unindexed.push(j);
          continue;
        }
        unindexed = undefined;
        let branch = byIndex.get(index);
        if (!branch) {
          byIndex.set(index, (branch = []));
          branches.push(branch);
        }
        branch.push(j);
      }
      satisfied = branches.some((branch) => branch.every((j) => excused(live[j]!, standIns)));
    }
    if (!satisfied) continue;
    live[k] = undefined;
    for (const j of owned) live[j] = undefined;
  }
  return live.filter((error): error is E => error !== undefined && !excused(error, standIns));
}
