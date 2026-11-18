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
 * - **A union** is decided by the judge (`schema-findings-judge.ts`), which
 *   validates each branch on its own and holds every finding it raises to these
 *   same rules, so a branch a stand-in could satisfy is valid.
 * - **A content keyword** (`uniqueItems`, `const`, `enum`) raised at a value that
 *   CONTAINS a stand-in compares placeholders, so it is decided on the parts the
 *   author wrote — and, for `uniqueItems`, on stand-ins that are the same
 *   repeatable expression written twice.
 *
 * Shared by every analyzer substitution site and by the kernel's create-time
 * validation, so `telo check` and the runtime excuse exactly the same findings.
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

/** A `oneOf` that failed because SEVERAL branches matched: which one a value
 *  takes is decided by its content, so it is value-level. */
export function isAmbiguousOneOf(error: AjvErrorLike): boolean {
  return error.keyword === "oneOf" && Array.isArray(error.params?.passingSchemas);
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

/** What the stand-ins in one validated value excuse, finding by finding. */
export interface StandInRule {
  /** True when a stand-in excuses `finding` wherever it was raised. */
  excused(finding: AjvErrorLike): boolean;
  /** The finding as it stands once the stand-ins are accounted for, or
   *  `undefined` when they excuse it. */
  standing(finding: LocatedFinding): LocatedFinding | undefined;
}

/**
 * The rule the stand-ins in `value` impose on a finding raised where it sits.
 * A union is not decided here: the judge (`schema-findings-judge.ts`) asks each
 * branch on its own and holds every finding it raises to this rule.
 *
 * `uniqueItems`, `const` and `enum` at a value CONTAINING a stand-in are decided
 * on the written parts. `uniqueItems` stands for two items EQUAL AS WRITTEN, and
 * names that pair: their literal parts are equal and, wherever one holds a
 * stand-in, the other holds a stand-in of the same tag with character-identical
 * repeatable text. A stand-in beside a literal, two different texts, two tags or
 * an unrepeatable text are never equal — the runtime judges those. `const` /
 * `enum` stand only when no allowed value agrees with what was written.
 */
export function standInRule(value: unknown, standIns: ReadonlyMap<string, StandIn>): StandInRule {
  const judgment = { value };
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

  return {
    excused: (finding) => excused(finding, standIns),
    standing: (finding) => (standIns.size === 0 ? finding : standing(finding)),
  };
}
