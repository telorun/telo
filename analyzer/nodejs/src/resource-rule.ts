/**
 * The single reader for `x-telo-resource-rules` — a kind declaring, as data,
 * relationships between the fields of one resource that JSON Schema cannot
 * state: an index naming a column its table does not declare, a foreign key
 * whose two sides differ in length, a rename whose source is still declared.
 *
 * The predicate is CEL over `self` (the whole resource) and `this` (the element
 * under test), so correlating two collections is a comprehension closure rather
 * than a path language with wildcard bindings to design. `in:` names the
 * collection to iterate and IS the diagnostic anchor: iterating what the pointer
 * names is what makes a reported path exist by construction.
 *
 * Vocabulary borrowed from `Telo.JsonSchema.rules` — `condition` true when the
 * rule HOLDS, the subject bound as `this`, plus `code` and `message` — because
 * two CEL rule vocabularies with opposite polarity is a trap an author falls
 * into once per rule. The two mechanisms stay separate: a `Telo.JsonSchema` rule
 * runs at dispatch against a value, this one at `telo check` against a manifest.
 *
 * Lenient by design, the `ref-slot.ts` precedent: anything unreadable here reads
 * as absent, and `validate-resource-rules.ts` is the strict half that reports it.
 *
 * Browser-safe: no Node built-ins.
 */
import { CEL_ENGINE, isRefSentinel, isTaggedSentinel } from "@telorun/templating";

export const RESOURCE_RULES_ANNOTATION = "x-telo-resource-rules";

export type ResourceRuleSeverity = "error" | "warning";

export interface ResourceRule {
  /** JSON Pointer to the collection to iterate. Absent = the whole-resource
   *  form, which reports at the resource rather than at an element. */
  readonly in?: string;
  /** CEL source. TRUE when the rule holds. */
  readonly condition: string;
  /** The rule's own name, carried in `data.rule`. Never a diagnostic code —
   *  every violation reports under the analyzer-owned envelope. */
  readonly code: string;
  readonly message: string;
  readonly severity: ResourceRuleSeverity;
  /** Position in the annotation array — the anchor for a declaration defect. */
  readonly index: number;
}

/** One element a rule is evaluated against. */
export interface RuleSubject {
  /** Dotted/bracketed path from the resource root, for `data.path`. */
  readonly path: string;
  readonly value: unknown;
  /** Present when the collection is a map: the entry's key. */
  readonly key?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True for a node the loader produced from a `!cel` tag or a `${{ }}` string.
 *  Both markers are tested because they are not always both present: a
 *  registered definition's schema reaches the analyzer with `call` and
 *  `__compiled` dropped, keeping only `__tagged` + `source`. Testing one would
 *  make a rule readable on some paths and invisible on others.
 *
 *  A tagged sentinel of ANOTHER engine is not one. `__tagged` marks every tag
 *  the loader parses — `!ref` above all — so testing it alone read a reference
 *  as an expression: a column whose `type:` holds a `!ref` skipped every rule
 *  that touched `self.columns`, and said "the value holds a CEL expression" about
 *  a manifest containing none. A reference names a declaration and is a
 *  perfectly comparable value; what a rule cannot compare is a value COMPUTED at
 *  create time, which is what this predicate exists to find. */
function isCelNode(value: unknown): value is { source?: unknown } {
  if (!isObject(value)) return false;
  if (value.__compiled === true) return true;
  return value.__tagged === true && value.engine === CEL_ENGINE;
}

/** The engine of a non-CEL tagged sentinel — a `!ref`, an `!include-*` — or
 *  `undefined`. A reference is comparable and never blocks a rule; the other
 *  tags hold a value only known once the resource is created, so they do, and
 *  the diagnostic has to name the tag rather than claim CEL. */
export function deferredTagOf(value: unknown): string | undefined {
  if (!isTaggedSentinel(value) || isRefSentinel(value)) return undefined;
  return value.engine === CEL_ENGINE ? undefined : value.engine;
}

/**
 * True when a condition was written with the `!cel` tag.
 *
 * The readers stay lenient and take a bare string — a rule still runs either
 * way. What an untagged condition loses is everything outside evaluation: to the
 * editor's colouring, completion and hover it is a plain string, so a rule author
 * writes CEL with no help and gets none of the checks a `!cel` scalar gets.
 * Losing that silently is exactly what a strict half exists to move earlier, so
 * the tag is reported by the strict halves and never enforced by the readers.
 */
export function isTaggedCondition(value: unknown): boolean {
  return isCelNode(value);
}

/** A precompiled `!cel` node keeps its author-written text on `source`; a plain
 *  string is taken verbatim so a rule reads the same however the loader was
 *  configured (a round-trip view runs with `compile` off). */
export function celSourceOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isCelNode(value) && typeof value.source === "string") return value.source;
  return undefined;
}

/** The annotation exactly as written, for the strict half. `undefined` when the
 *  kind declares none; a non-array is returned as-is so the shape can be
 *  reported rather than silently skipped. */
export function readRawResourceRules(schema: unknown): unknown {
  if (!isObject(schema)) return undefined;
  return schema[RESOURCE_RULES_ANNOTATION];
}

/** Every rule this kind declares that is well-formed enough to run. */
export function readResourceRules(schema: unknown): ResourceRule[] {
  const raw = readRawResourceRules(schema);
  if (!Array.isArray(raw)) return [];
  const rules: ResourceRule[] = [];
  raw.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const condition = celSourceOf(entry.condition);
    const { code, message } = entry;
    if (!condition || typeof code !== "string" || typeof message !== "string") return;
    if (code.length === 0 || message.length === 0) return;
    const severity = entry.severity === "warning" ? "warning" : "error";
    if (entry.severity !== undefined && entry.severity !== "warning" && entry.severity !== "error") {
      return;
    }
    const pointer = entry.in;
    if (pointer !== undefined && typeof pointer !== "string") return;
    rules.push({
      ...(pointer === undefined ? {} : { in: pointer }),
      condition,
      code,
      message,
      severity,
      index,
    });
  });
  return rules;
}

/** Split a JSON Pointer into its unescaped segments. `/` alone is the root. */
export function pointerSegments(pointer: string): string[] | undefined {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Navigate a pointer within a value, stopping at anything that is not a plain
 *  container. Returns `undefined` for a pointer that does not resolve — which a
 *  resource legitimately produces by omitting an optional collection. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (!segments) return undefined;
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Path prefix for a pointer, in the dotted/bracketed spelling diagnostics use
 *  (`foreignKeys[0].references`), so `data.path` is one grammar throughout. */
export function pointerToPath(pointer: string): string {
  const segments = pointerSegments(pointer) ?? [];
  return segments.reduce<string>((acc, segment) => {
    if (/^\d+$/.test(segment)) return `${acc}[${segment}]`;
    return acc === "" ? segment : `${acc}.${segment}`;
  }, "");
}

/**
 * The elements a rule iterates. An array yields one subject per item, a map one
 * per entry with its key bound; a collection that is absent yields none, which
 * is a rule that had nothing to say rather than a rule that failed.
 *
 * A scalar at the pointer is `undefined` — not an empty list — because that is a
 * declaration defect the strict half reports, and an empty list would hide it.
 */
export function resolveRuleSubjects(
  config: unknown,
  pointer: string,
): RuleSubject[] | undefined {
  const collection = resolvePointer(config, pointer);
  if (collection === undefined || collection === null) return [];
  const base = pointerToPath(pointer);
  if (Array.isArray(collection)) {
    return collection.map((value, index) => ({ path: `${base}[${index}]`, value }));
  }
  if (isObject(collection)) {
    return Object.entries(collection).map(([key, value]) => ({
      path: `${base}.${key}`,
      value,
      key,
    }));
  }
  return undefined;
}

/** The first leaf a rule cannot compare, and what it is. `what` is a noun
 *  phrase the diagnostic quotes verbatim, because "a CEL expression" printed
 *  over an `!include-bytes` embed sends its author looking for an expression
 *  that is not there. */
export interface DynamicLeaf {
  readonly path: string;
  readonly what: string;
}

/** Classify ONE node, without descending. Exported because a caller that draws
 *  its own bound on how far to look (`peer-binding`'s top-level-scalar scan)
 *  must classify by the same rule as the recursive walk, or a `!ref` is a
 *  reference to one of them and an expression to the other. */
export function dynamicNode(value: unknown, path: string): DynamicLeaf | undefined {
  const at = path || "(value)";
  if (isCelNode(value)) return { path: at, what: "a CEL expression" };
  const tag = deferredTagOf(value);
  return tag ? { path: at, what: `an !${tag} embed` } : undefined;
}

/**
 * The first leaf inside a value whose contents are not known until the resource
 * is created, or `undefined` when every leaf is literal. A rule reading one
 * would be comparing against a placeholder, so the subject is skipped — and the
 * skip is reported, never silent.
 *
 * A `!ref` is NOT one of them. It is a tagged sentinel like `!cel`, and testing
 * `__tagged` alone read every reference as an expression: a column whose `type:`
 * holds a `!ref` switched off every rule touching `self.columns` and reported a
 * CEL expression in a manifest containing none. A reference names a declaration
 * — a value a rule compares perfectly well, and the one peer rules are built on.
 *
 * Stops at nested inline `{ kind }` declarations for the reason every other walk
 * does: that CEL belongs to the nested kind, evaluated in its own scope.
 */
export function findDynamicLeaf(value: unknown, base = ""): DynamicLeaf | undefined {
  if (isObject(value)) {
    const own = dynamicNode(value, base);
    if (own) return own;
    if (typeof value.kind === "string" && base !== "") return undefined;
    for (const [key, child] of Object.entries(value)) {
      const found = findDynamicLeaf(child, base === "" ? key : `${base}.${key}`);
      if (found) return found;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDynamicLeaf(value[i], `${base}[${i}]`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The nodes a condition actually READS, resolved against the resource and the
 * element under test — the input to the dynamic-leaf check.
 *
 * Scanning the whole subject instead would make the check useless in exactly
 * the shape it matters most: a resource-wide rule takes the whole resource as
 * its subject, so one unrelated `!cel` anywhere (a `version:` read from
 * `module.version`, which is the conventional spelling) would switch off every
 * such rule. Chains are the same primitive the binding-order derivation uses:
 * parsed, never lexed, so a name inside a string literal reads nothing.
 *
 * A chain stops at a computed index (`INDEX_SEGMENT`): what it selects is not
 * known statically, so the node reached so far is what gets checked — the
 * over-approximating direction, which errs toward skipping rather than toward
 * evaluating a placeholder.
 */
export function readNodes(
  chains: readonly (readonly string[])[],
  /** The bindings in scope, by name — `self`/`this`/`key` for a resource rule,
   *  `self`/`referrer` for a referrer rule. A chain rooted at a name that is not
   *  bound reads nothing. */
  roots: Record<string, unknown>,
): unknown[] {
  const nodes: unknown[] = [];
  for (const chain of chains) {
    const root = chain[0];
    let current: unknown = root !== undefined && root in roots ? roots[root] : undefined;
    if (current === undefined) continue;
    for (const segment of chain.slice(1)) {
      if (segment === "[*]") break;
      if (Array.isArray(current)) {
        const index = Number(segment);
        current = Number.isInteger(index) ? current[index] : undefined;
      } else if (isObject(current)) {
        current = current[segment];
      } else {
        current = undefined;
      }
      if (current === undefined) break;
    }
    if (current !== undefined) nodes.push(current);
  }
  return nodes;
}
