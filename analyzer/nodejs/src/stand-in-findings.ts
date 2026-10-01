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
 * One principle decides everything else: a finding stands only if it holds for
 * every value the stand-ins could take.
 *
 * - **A union** is decided by validating its value against each branch ON ITS
 *   OWN and judging that branch's findings by these same rules. A validator's
 *   flat error list cannot say which branch — if any — raised a finding inside a
 *   referenced shape, so nothing is attributed by reading it: a finding is the
 *   union's only when a branch validated alone reproduces it. A branch is judged
 *   with no `default:` applied and nothing written: defaults reach the value
 *   only from the host's whole-schema validation, so a branch requiring a member
 *   it merely defaults is not satisfied, as it is not for a literal.
 * - **A content keyword** (`uniqueItems`, `const`, `enum`) raised at a value that
 *   CONTAINS a stand-in compares placeholders, so it is decided on the parts the
 *   author wrote — and, for `uniqueItems`, on stand-ins that are the same
 *   repeatable expression written twice.
 *
 * The judge runs on RAW validator errors, before union reduction collapses them
 * into issues. Shared by every analyzer substitution site and by the kernel's
 * create-time validation, so `telo check` and the runtime excuse exactly the
 * same findings.
 */

import { isCompiledValue } from "@telorun/sdk";
import {
  defaultRegistry,
  isRefSentinel,
  isTaggedSentinel,
  producedTypeOf,
  repeatableSource,
} from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";
import type { AjvErrorLike } from "./schema-error-report.js";

export type StandInClass = "computed" | "produced";

/**
 * What makes two stand-ins the same expression: the tag, its text, and whether
 * that text is REPEATABLE — means one value wherever it is written twice in one
 * value. The verdict is the tag's engine's, on the text alone, asked when first
 * read.
 */
export interface StandInIdentity {
  readonly tag: string;
  readonly text: string;
  readonly repeatable: boolean;
}

/** One stand-in: what its tag guarantees, and — where the tag and its text are
 *  known — which expression it stands for. */
export interface StandIn {
  readonly class: StandInClass;
  readonly identity?: StandInIdentity;
}

/** Every stand-in substituted into one value, keyed by its JSON Pointer from the
 *  validated root — the form an AJV `instancePath` takes. */
export type StandIns = Map<string, StandIn>;

/** What a tagged or compiled value is to validation: a stand-in (with the
 *  produced type, for a produced one), or the plain value its engine already
 *  resolved it to. */
export type StandInReading =
  | (StandIn & { readonly kind: "stand-in"; readonly class: "computed" })
  | (StandIn & {
      readonly kind: "stand-in";
      readonly class: "produced";
      readonly produced: Record<string, any>;
    })
  | { readonly kind: "value"; readonly value: unknown };

let compileEnv: ReturnType<typeof buildCelEnvironment> | undefined;

function identityOf(tag: string, text: string): StandInIdentity {
  let verdict: boolean | undefined;
  return {
    tag,
    text,
    get repeatable() {
      compileEnv ??= buildCelEnvironment();
      return (verdict ??= repeatableSource(tag, text, compileEnv));
    },
  };
}

/**
 * Classify a tagged sentinel or a compiled value, or undefined for anything else
 * (a `!ref` is an identity marker, never a stand-in).
 *
 * Read off the engine's compile contract, never off a tag name: an engine whose
 * scalar holds CEL defers to evaluation by construction, and any other engine is
 * asked to compile — a plain result is a value resolved now (`!literal`), a
 * marker or compiled value is one that exists only after load. The class is then
 * whether the engine declares a produced type.
 *
 * The identity is read off the same two facts in both forms — the tag and the
 * text as written — never off what compiling resolved, which a tagged sentinel
 * does not carry: `telo check` and the kernel must call the same pair equal.
 */
export function readStandIn(value: unknown): StandInReading | undefined {
  let engineName: string | undefined;
  let text: string | undefined;
  if (isCompiledValue(value)) {
    const engine = (value as { engine?: unknown }).engine;
    engineName = typeof engine === "string" ? engine : undefined;
    text = typeof value.source === "string" ? value.source : undefined;
  } else if (isTaggedSentinel(value)) {
    if (isRefSentinel(value)) return undefined;
    engineName = value.engine;
    text = value.source;
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
  const identity =
    engineName === undefined || text === undefined
      ? {}
      : { identity: identityOf(engineName, text) };
  return produced
    ? { kind: "stand-in", class: "produced", produced: produced as Record<string, any>, ...identity }
    : { kind: "stand-in", class: "computed", ...identity };
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

/** Keywords that compare a value's parts with each other or with a constant, so
 *  a stand-in INSIDE the value decides them without being the value judged. */
const CONTENT_KEYWORDS: ReadonlySet<string> = new Set(["uniqueItems", "const", "enum"]);

/**
 * A finding with the schema node that raised it, as the validator itself
 * reports it (AJV's `verbose` errors). `schemaPath` cannot stand in for the
 * node: inside a referenced shape it is relative to that shape, so two findings
 * with one path may come from two documents.
 */
export interface LocatedFinding extends AjvErrorLike {
  /** The failing keyword's own value — a union's branch list. */
  schema?: unknown;
  /** The schema node holding the failing keyword. */
  parentSchema?: unknown;
}

/**
 * Every finding `node` raises against `value`, validated inside the document
 * that declares `node` so its own `#/…` references resolve, each finding located.
 * Asked about the judged schema itself, the findings are the host's own
 * whole-schema validation's — whatever defaults that fills are in `value` when
 * it returns; asked about a node inside it, no default is applied and nothing is
 * written. `undefined` when the node lies in no document the validator holds.
 */
export type SchemaNodeFindings = (
  node: object,
  value: unknown,
) => readonly LocatedFinding[] | undefined;

/** What the judge decides over: one validated value, and the means to ask about
 *  a part of its schema. */
export interface StandInJudgment {
  /** The value that was validated, stand-ins in place. */
  value: unknown;
  /** The schema it was validated against. */
  schema: Record<string, any>;
  /** Every stand-in in `value`, by JSON Pointer. */
  standIns: ReadonlyMap<string, StandIn>;
  validate: SchemaNodeFindings;
}

/** A `oneOf` that failed because SEVERAL branches matched: which one a value
 *  takes is decided by its content, so it is value-level. */
function isAmbiguousOneOf(error: AjvErrorLike): boolean {
  return error.keyword === "oneOf" && Array.isArray(error.params?.passingSchemas);
}

function isUnion(error: AjvErrorLike): boolean {
  return UNION_KEYWORDS.has(error.keyword ?? "");
}

/** True when a stand-in excuses this finding: it sits at or below a computed
 *  stand-in, or at or below a produced one and is judged on content. */
function excused(error: AjvErrorLike, standIns: ReadonlyMap<string, StandIn>): boolean {
  const valueLevel = VALUE_CONSTRAINT_KEYWORDS.has(error.keyword ?? "") || isAmbiguousOneOf(error);
  let path: string | undefined = error.instancePath ?? "";
  while (path !== undefined) {
    const standIn = standIns.get(path)?.class;
    if (standIn === "computed" || (standIn === "produced" && valueLevel)) return true;
    path = path === "" ? undefined : path.slice(0, Math.max(0, path.lastIndexOf("/")));
  }
  return false;
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The value at a JSON Pointer under `root`. */
function valueAt(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      segment.replace(/~1/g, "/").replace(/~0/g, "~")
    ];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural equality over JSON data, as the validator's own `uniqueItems`
 *  compares; an instance is equal only to itself. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

/** Whether two values are of one kind — what a produced stand-in fixes about
 *  the value it stands for. */
function sameKind(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return typeof a === typeof b;
  return Array.isArray(a) === Array.isArray(b) && Object.getPrototypeOf(a) === Object.getPrototypeOf(b);
}

/** One union, decided: whether a branch accepts the value for some reading of
 *  its stand-ins, and every finding its branches raise, counted. */
interface UnionVerdict {
  satisfied: boolean;
  reproduced: ReadonlyMap<string, number>;
}

/** The fields a finding is rendered and anchored from, without the validator's
 *  references into its schema and data. */
function plainFinding(finding: LocatedFinding): AjvErrorLike {
  return {
    ...(finding.keyword !== undefined ? { keyword: finding.keyword } : {}),
    ...(finding.instancePath !== undefined ? { instancePath: finding.instancePath } : {}),
    ...(finding.schemaPath !== undefined ? { schemaPath: finding.schemaPath } : {}),
    ...(finding.message !== undefined ? { message: finding.message } : {}),
    ...(finding.params !== undefined ? { params: finding.params } : {}),
  };
}

/**
 * Drop every finding a stand-in excuses.
 *
 * A failed union is decided by validating its value against each branch on its
 * own and judging that branch's findings by this same rule, recursively: the
 * union is satisfied when one branch has no surviving finding, and then its own
 * finding and the findings its branches reproduce are dropped — counted, so a
 * finding raised once more than the branches reproduce (a sibling reference to
 * the shape a branch names) is kept that once. An unsatisfied union keeps its
 * findings, minus those individually excused. A union whose node lies in no
 * document the validator holds is kept with everything raised around it.
 *
 * `uniqueItems`, `const` and `enum` at a value CONTAINING a stand-in are decided
 * on the written parts. `uniqueItems` stands for two items EQUAL AS WRITTEN, and
 * names that pair: their literal parts are equal and, wherever one holds a
 * stand-in, the other holds a stand-in of the same tag with character-identical
 * repeatable text. A stand-in beside a literal, two different texts, two tags or
 * an unrepeatable text are never equal — the runtime judges those. `const` /
 * `enum` stand only when no allowed value agrees with what was written.
 */
export function withoutStandInFindings(
  errors: readonly LocatedFinding[] | null | undefined,
  judgment: StandInJudgment,
): AjvErrorLike[] {
  if (!errors || errors.length === 0) return [];
  const { standIns } = judgment;
  if (standIns.size === 0) return [...errors];

  // Every path with a stand-in beneath it, built for the first content finding.
  let holders: Set<string> | undefined;
  const holdsStandIn = (path: string): boolean => {
    if (!holders) {
      holders = new Set();
      for (const pointer of standIns.keys()) {
        for (let end = pointer.lastIndexOf("/"); end >= 0; ) {
          const parent = pointer.slice(0, end);
          if (holders.has(parent)) break;
          holders.add(parent);
          end = parent.lastIndexOf("/");
        }
      }
    }
    return holders.has(path);
  };

  // The engine's verdict, asked once per (tag, text) in this judgment.
  const repeatable = new Map<string, boolean>();
  const instanceIds = new WeakMap<object, number>();
  let nextInstanceId = 0;
  /**
   * A canonical rendering of a value as written: two values with one key are
   * equal for every value their stand-ins could take. A stand-in renders as its
   * identity; a value holding one with no identity, or an unrepeatable one, has
   * no key and equals nothing.
   */
  const writtenKey = (value: unknown, path: string): string | undefined => {
    const standIn = standIns.get(path);
    if (standIn) {
      const identity = standIn.identity;
      if (!identity) return undefined;
      const key = `!${JSON.stringify(identity.tag)}${JSON.stringify(identity.text)}`;
      let verdict = repeatable.get(key);
      if (verdict === undefined) repeatable.set(key, (verdict = identity.repeatable));
      return verdict ? key : undefined;
    }
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = writtenKey(value[i], `${path}/${i}`);
        if (item === undefined) return undefined;
        items.push(item);
      }
      return `[${items.join(",")}]`;
    }
    if (isPlainObject(value)) {
      const members: string[] = [];
      for (const name of Object.keys(value).sort()) {
        const member = writtenKey(value[name], `${path}/${escapeSegment(name)}`);
        if (member === undefined) return undefined;
        members.push(`${JSON.stringify(name)}:${member}`);
      }
      return `{${members.join(",")}}`;
    }
    if (typeof value === "string") return JSON.stringify(value);
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      // An instance is equal only to itself.
      let id = instanceIds.get(value);
      if (id === undefined) instanceIds.set(value, (id = nextInstanceId++));
      return `@${id}`;
    }
    return `${typeof value}:${String(value)}`;
  };

  /** The last two items of `written` that are equal as written, or `undefined`. */
  const writtenDuplicate = (written: readonly unknown[], path: string): [number, number] | undefined => {
    const seen = new Map<string, number>();
    let pair: [number, number] | undefined;
    for (let i = 0; i < written.length; i++) {
      const key = writtenKey(written[i], `${path}/${i}`);
      if (key === undefined) continue;
      const earlier = seen.get(key);
      if (earlier !== undefined) pair = [earlier, i];
      seen.set(key, i);
    }
    return pair;
  };

  /** Whether `allowed` is what `written` could become: equal where the author
   *  wrote a value, anything of the stand-in's kind where they did not. */
  const agrees = (written: unknown, allowed: unknown, path: string): boolean => {
    const standIn = standIns.get(path)?.class;
    if (standIn === "computed") return true;
    if (standIn === "produced") return sameKind(written, allowed);
    if (Array.isArray(written)) {
      return (
        Array.isArray(allowed) &&
        written.length === allowed.length &&
        written.every((item, i) => agrees(item, allowed[i], `${path}/${i}`))
      );
    }
    if (!isPlainObject(written) || !isPlainObject(allowed)) return sameValue(written, allowed);
    const keys = Object.keys(written);
    return (
      keys.length === Object.keys(allowed).length &&
      keys.every(
        (key) =>
          Object.hasOwn(allowed, key) &&
          agrees(written[key], allowed[key], `${path}/${escapeSegment(key)}`),
      )
    );
  };

  /** The finding as it stands once the stand-ins are accounted for, or
   *  `undefined` when they excuse it. */
  const standing = (finding: LocatedFinding): LocatedFinding | undefined => {
    if (excused(finding, standIns)) return undefined;
    const keyword = finding.keyword ?? "";
    const path = finding.instancePath ?? "";
    if (!CONTENT_KEYWORDS.has(keyword) || !holdsStandIn(path)) return finding;
    const written = valueAt(judgment.value, path);
    if (keyword !== "uniqueItems") {
      const allowed =
        keyword === "const" ? [finding.params?.allowedValue] : finding.params?.allowedValues;
      if (!Array.isArray(allowed)) return finding;
      return allowed.some((value) => agrees(written, value, path)) ? undefined : finding;
    }
    if (!Array.isArray(written)) return finding;
    const pair = writtenDuplicate(written, path);
    if (!pair) return undefined;
    const [j, i] = pair;
    return {
      ...finding,
      params: { i, j },
      message: `must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
    };
  };

  const nodeIds = new WeakMap<object, number>();
  let nextNodeId = 0;
  const nodeId = (node: unknown): string => {
    if (node === null || typeof node !== "object") return "-";
    let id = nodeIds.get(node);
    if (id === undefined) nodeIds.set(node, (id = nextNodeId++));
    return String(id);
  };
  /** What makes two findings one: where, what, raised by which node, how. */
  const findingKey = (finding: LocatedFinding): string =>
    [
      finding.instancePath ?? "",
      finding.keyword ?? "",
      nodeId(finding.parentSchema),
      JSON.stringify(finding.params ?? {}),
    ].join("\0");

  // A union is judged once per (union node, value location).
  const verdicts = new Map<string, UnionVerdict | undefined>();

  const verdictOf = (union: LocatedFinding): UnionVerdict | undefined => {
    const node = union.parentSchema;
    const branches = union.schema;
    if (node === null || typeof node !== "object" || !Array.isArray(branches)) return undefined;
    const path = union.instancePath ?? "";
    const key = [nodeId(node), union.keyword, path].join("\0");
    if (verdicts.has(key)) return verdicts.get(key);
    // Unlocated until decided: a union reached again while it is being judged
    // is kept, never guessed at.
    verdicts.set(key, undefined);
    const value = valueAt(judgment.value, path);
    const reproduced = new Map<string, number>();
    let satisfied = false;
    for (const branch of branches) {
      if (branch === null || typeof branch !== "object") return undefined;
      const raised = judgment.validate(branch, value);
      // The branch lies in no held document: the union is kept, never guessed at.
      if (!raised) return undefined;
      const findings = raised.map((finding) => ({
        ...finding,
        instancePath: `${path}${finding.instancePath ?? ""}`,
      }));
      for (const finding of findings) {
        const findingId = findingKey(finding);
        reproduced.set(findingId, (reproduced.get(findingId) ?? 0) + 1);
      }
      if (surviving(findings).length === 0) satisfied = true;
    }
    // Which of several matching branches a value takes is decided by its
    // content, so that failure is excused where the value is a stand-in's.
    const verdict = {
      satisfied: isAmbiguousOneOf(union) ? excused(union, standIns) : satisfied,
      reproduced,
    };
    verdicts.set(key, verdict);
    return verdict;
  };

  /** Where each finding sits, by what makes two findings one, ascending. */
  const positionsByKey = (findings: readonly LocatedFinding[]): Map<string, number[]> => {
    const positions = new Map<string, number[]>();
    findings.forEach((finding, index) => {
      const key = findingKey(finding);
      const at = positions.get(key);
      if (at) at.push(index);
      else positions.set(key, [index]);
    });
    return positions;
  };

  const surviving = (findings: readonly LocatedFinding[]): LocatedFinding[] => {
    const live: (LocatedFinding | undefined)[] = [...findings];
    let positions: Map<string, number[]> | undefined;
    // Outermost first: a validator reports a union after everything its
    // branches raised, nested unions included.
    for (let k = live.length - 1; k >= 0; k--) {
      const union = live[k];
      if (!union || !isUnion(union)) continue;
      const verdict = verdictOf(union);
      if (!verdict?.satisfied) continue;
      live[k] = undefined;
      positions ??= positionsByKey(findings);
      // What the branches reproduce is dropped nearest the union first. Unions
      // are met in descending order, so a position at or past this one is never
      // asked for again, and one a list still holds below it is live.
      for (const [key, count] of verdict.reproduced) {
        const at = positions.get(key);
        if (!at) continue;
        while (at.length > 0 && at[at.length - 1]! >= k) at.pop();
        for (let owed = count; owed > 0 && at.length > 0; owed--) live[at.pop()!] = undefined;
      }
    }
    const out: LocatedFinding[] = [];
    for (const finding of live) {
      const kept = finding && standing(finding);
      if (kept) out.push(kept);
    }
    return out;
  };

  // Only a union needs its node: every other finding is decided where it sits.
  const located =
    errors.every((error) => !isUnion(error) || typeof error.parentSchema === "object")
      ? errors
      : judgment.validate(judgment.schema, judgment.value);
  // No located twin of the list — the schema lies in no held document: nothing
  // is attributed to a union, so every union stays, with what was raised around
  // it.
  const judged = located && located.length > 0 ? located : errors;
  return surviving(judged).map(plainFinding);
}
