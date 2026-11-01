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
import {
  CEL_ENGINE,
  EACH_SEGMENT,
  PRESENCE_SEGMENT,
  INDEX_SEGMENT,
  isRefSentinel,
  isTaggedSentinel,
} from "@telorun/templating";
import {
  crossingPlace,
  placeAt,
  pointerPlaces,
  READS_WHOLE,
  type ReadKeys,
  type ReferentPlace,
  type ReferentReads,
} from "./read-place.js";
import { compileRuleCondition } from "./rule-condition.js";
import type { ResourceDefinition } from "@telorun/sdk";
import { authorSchemaChain, type DefResolver } from "./extends-resolution.js";
import { RESOURCE_RULES_ANNOTATION } from "./rule-inheritance.js";

export { RESOURCE_RULES_ANNOTATION };

export type ResourceRuleSeverity = "error" | "warning";

export interface ResourceRule {
  /** JSON Pointer to the collection to iterate — or, with `*` and repeated
   *  groups ({@link parseRulePointer}), to every collection it names. Absent =
   *  the whole-resource form, which reports at the resource rather than at an
   *  element. */
  readonly in?: string;
  /** JSON Pointers to this kind's own reference slots whose declarations the
   *  condition reads in place of the references, resolved one level — a single
   *  slot becomes the declaration it names, a collection its entries resolved.
   *  Opt-in, because rewriting `self` for every rule would change what existing
   *  rules read. */
  readonly resolve?: readonly string[];
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
  /** Present when the pointer reached a value known only once the resource is
   *  created — the collection itself, or a container on the way to it: the
   *  rule cannot run there, and the skip is reported. */
  readonly dynamic?: DynamicLeaf;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True for a node the loader produced from a `!cel` tag.
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
    const resolve = entry.resolve;
    if (
      resolve !== undefined &&
      !(Array.isArray(resolve) && resolve.every((p) => typeof p === "string" && pointerSegments(p)))
    ) {
      return;
    }
    rules.push({
      ...(pointer === undefined ? {} : { in: pointer }),
      ...(resolve === undefined ? {} : { resolve: resolve as string[] }),
      condition,
      code,
      message,
      severity,
      index,
    });
  });
  return rules;
}

/** The rules one definition of an `extends` chain declares itself. */
export interface DeclaredResourceRules {
  readonly declarer: ResourceDefinition;
  readonly rules: readonly ResourceRule[];
}

/**
 * The rules a kind's resources are judged by, grouped by the definition that
 * declares them, ancestors first — the chain `effectiveAuthorSchema` joins, with
 * each rule's `index` its place in its own declarer's annotation, which is where
 * a defect in it is reported. A code already inherited is not read again.
 */
export function declaredResourceRules(
  definition: ResourceDefinition,
  resolve: DefResolver,
): DeclaredResourceRules[] {
  const seen = new Set<string>();
  const out: DeclaredResourceRules[] = [];
  for (const declarer of authorSchemaChain(definition, resolve)) {
    const rules = readResourceRules(declarer.schema).filter((rule) => !seen.has(rule.code));
    for (const rule of rules) seen.add(rule.code);
    if (rules.length > 0) out.push({ declarer, rules });
  }
  return out;
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

/**
 * One step of a rule's `in:` pointer: a key, `*` (every item of a list or value
 * of a map), or a group of steps repeated zero or more times — the repeated-group
 * form of the eval-path grammar (`content(.children[*])*`), spelled as pointer
 * segments, with `|` between alternatives. A group is how one rule visits every
 * entry of a tree of unknown depth: a navigation's `items`, then the `items` of
 * each of their entries, repeated.
 */
export type RulePointerStep =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "any" }
  | { readonly kind: "repeat"; readonly alternatives: readonly (readonly RulePointerStep[])[] };

/**
 * A rule's `in:` pointer as steps; `undefined` when it is not one. A key cannot
 * hold `(`, `)` or `|`, which the grammar reads; a group repeats a non-empty
 * list of steps, and groups nest.
 */
export function parseRulePointer(pointer: string): RulePointerStep[] | undefined {
  if (pointer === "" || pointer === "/") return [];
  let at = 0;
  const steps = (closing: boolean): RulePointerStep[] | undefined => {
    const out: RulePointerStep[] = [];
    while (at < pointer.length) {
      const c = pointer[at]!;
      if (c === ")" || c === "|") return closing ? out : undefined;
      if (c === "(") {
        at++;
        const alternatives: RulePointerStep[][] = [];
        for (;;) {
          const alternative = steps(true);
          if (!alternative || alternative.length === 0) return undefined;
          alternatives.push(alternative);
          if (pointer[at] === "|") {
            at++;
            continue;
          }
          if (pointer.startsWith(")*", at)) {
            at += 2;
            break;
          }
          return undefined;
        }
        out.push({ kind: "repeat", alternatives });
        continue;
      }
      if (c !== "/") return undefined;
      at++;
      let end = at;
      while (end < pointer.length && !"/()|".includes(pointer[end]!)) end++;
      const raw = pointer.slice(at, end);
      at = end;
      out.push(raw === "*" ? { kind: "any" } : { kind: "key", key: raw.replace(/~1/g, "/").replace(/~0/g, "~") });
    }
    return closing ? undefined : out;
  };
  const parsed = steps(false);
  return parsed && at === pointer.length ? parsed : undefined;
}

/** Whether a parsed pointer names one place only: no `*` and no group. */
function namesOnePlace(steps: readonly RulePointerStep[]): boolean {
  return steps.every((step) => step.kind === "key");
}

/** A place a pointer reaches in a value, with the path that names it. A place
 *  holding a value known only at creation is carried on unchanged through every
 *  later step: what lies beneath it is unknown. */
interface PointerPlace {
  readonly value: unknown;
  readonly path: string;
  readonly dynamic?: DynamicLeaf;
}

/** A key or index appended to a diagnostic path. */
function joinPath(base: string, key: string | number): string {
  if (typeof key === "number" || /^\d+$/.test(key)) return `${base}[${key}]`;
  return base === "" ? key : `${base}.${key}`;
}

/** The deepest a repeated group is followed into a value. A manifest is a tree,
 *  so this only bounds a value that is not one. */
const MAX_REPEAT_DEPTH = 64;

/**
 * Every place `steps` reaches from each of `from`, in order, each once — two
 * alternatives of a group reaching one place yield it once.
 *
 * A step never looks inside a tagged value (`!cel`, an embed, a `!ref`) or a
 * compiled one: a value known only at creation becomes a `dynamic` place that
 * every later step carries unchanged, and a reference is no container.
 */
function placesAlong(from: readonly PointerPlace[], steps: readonly RulePointerStep[]): PointerPlace[] {
  let places = [...from];
  for (const step of steps) {
    const next: PointerPlace[] = [];
    const seen = new Set<string>();
    const reach = (place: PointerPlace) => {
      if (seen.has(place.path)) return;
      seen.add(place.path);
      next.push(place);
    };
    const child = (value: unknown, path: string) => {
      const dynamic = dynamicNode(value, path);
      reach(dynamic ? { value, path, dynamic } : { value, path });
    };
    for (const place of places) {
      const { value, path } = place;
      if (place.dynamic) {
        reach(place);
        continue;
      }
      if (isTaggedSentinel(value) || isCelNode(value)) continue;
      if (step.kind === "key") {
        if (Array.isArray(value)) {
          const index = Number(step.key);
          if (Number.isInteger(index) && value[index] !== undefined) child(value[index], joinPath(path, index));
        } else if (isObject(value) && value[step.key] !== undefined) {
          child(value[step.key], joinPath(path, step.key));
        }
      } else if (step.kind === "any") {
        if (Array.isArray(value)) value.forEach((item, index) => child(item, joinPath(path, index)));
        else if (isObject(value)) {
          for (const [key, item] of Object.entries(value)) child(item, joinPath(path, key));
        }
      } else {
        let frontier: PointerPlace[] = [place];
        reach(place);
        for (let depth = 0; frontier.length > 0 && depth < MAX_REPEAT_DEPTH; depth++) {
          frontier = step.alternatives
            .flatMap((alternative) => placesAlong(frontier, alternative))
            .filter((reached) => !seen.has(reached.path));
          frontier.forEach(reach);
          // A dynamic place has nothing beneath it to repeat into.
          frontier = frontier.filter((reached) => !reached.dynamic);
        }
      }
    }
    places = next;
  }
  return places;
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
 * is a rule that had nothing to say rather than a rule that failed. A
 * collection known only once the resource is created — an expression at the
 * pointer or above it — yields one subject carrying `dynamic`, which the rule
 * reports as skipped.
 *
 * A scalar at a single pointer is `undefined` — not an empty list — because that
 * is a declaration defect the strict half reports, and an empty list would hide
 * it. A pattern is checked by the strict half only for reaching a declared
 * collection, which a place of it holding something else in this resource does
 * not contradict: that place contributes nothing, as an absent one does, and
 * schema validation reports the value.
 */
export function resolveRuleSubjects(
  config: unknown,
  pointer: string,
): RuleSubject[] | undefined {
  const steps = parseRulePointer(pointer);
  if (!steps) return [];
  const one = namesOnePlace(steps);
  const subjects: RuleSubject[] = [];
  for (const place of placesAlong([{ value: config, path: "" }], steps)) {
    if (place.dynamic) {
      subjects.push({ path: place.path, value: place.value, dynamic: place.dynamic });
      continue;
    }
    if (place.value === null || isTaggedSentinel(place.value)) continue;
    const each = subjectsOf(place.value, place.path);
    if (!each) {
      if (one) return undefined;
      continue;
    }
    subjects.push(...each);
  }
  return subjects;
}

/** The elements of one collection, or `undefined` for a value that is none. */
function subjectsOf(collection: unknown, base: string): RuleSubject[] | undefined {
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

/** A node a condition reads, with the chain that reached it spelled as a path
 *  (`self.routes[1].path`). */
export interface ReadNode {
  readonly node: unknown;
  readonly path: string;
}

/**
 * The nodes a condition actually READS, resolved against the resource and the
 * element under test — the input to the dynamic-leaf check.
 *
 * Scanning the whole subject instead would make the check useless in exactly
 * the shape it matters most: a resource-wide rule takes the whole resource as
 * its subject, so one unrelated `!cel` anywhere (a `version:` read from
 * `module.version`, which is the conventional spelling) would switch off every
 * such rule. Chains are parsed, never lexed, so a name inside a string literal
 * reads nothing.
 *
 * A chain stops at a computed index (`INDEX_SEGMENT`): what it selects is not
 * known statically, so the node reached so far is what gets checked — the
 * over-approximating direction, which errs toward skipping rather than toward
 * evaluating a placeholder.
 *
 * `EACH_SEGMENT` is a comprehension's iteration variable: the rest of the chain
 * is read on every element of the collection reached so far. A chain ENDING
 * there is a collection that is only iterated — none of its elements is read,
 * and only a collection that is itself not known until creation counts.
 */
export function readNodes(
  chains: readonly (readonly string[])[],
  /** The bindings in scope, by name — `self`/`this`/`key` for a resource rule,
   *  `self`/`referrer` for a referrer rule. A chain rooted at a name that is not
   *  bound reads nothing. */
  roots: Record<string, unknown>,
): ReadNode[] {
  const nodes: ReadNode[] = [];
  const walk = (start: unknown, chain: readonly string[], from: number, at: string): void => {
    let current = start;
    let path = at;
    for (let i = from; i < chain.length; i++) {
      const segment = chain[i]!;
      if (segment === INDEX_SEGMENT) break;
      // A presence test depends on the keys of what was reached: on its values
      // only when it is itself not yet known.
      if (segment === PRESENCE_SEGMENT) {
        if (dynamicNode(current, path)) nodes.push({ node: current, path });
        return;
      }
      if (segment === EACH_SEGMENT) {
        if (dynamicNode(current, path)) break;
        if (i === chain.length - 1) return;
        if (Array.isArray(current)) {
          current.forEach((item, index) => walk(item, chain, i + 1, `${path}[${index}]`));
        } else if (isObject(current)) {
          for (const [key, item] of Object.entries(current)) {
            walk(item, chain, i + 1, `${path}.${key}`);
          }
        }
        return;
      }
      if (Array.isArray(current)) {
        const index = Number(segment);
        current = Number.isInteger(index) ? current[index] : undefined;
        path = `${path}[${segment}]`;
      } else if (isObject(current)) {
        current = current[segment];
        path = `${path}.${segment}`;
      } else {
        current = undefined;
      }
      if (current === undefined) return;
    }
    if (current !== undefined) nodes.push({ node: current, path });
  };
  for (const chain of chains) {
    const root = chain[0];
    if (root === undefined || !(root in roots) || roots[root] === undefined) continue;
    walk(roots[root], chain, 1, root);
  }
  return nodes;
}

/** The first leaf a condition reads that is not known until the resource is
 *  created, named by the chain that reads it. */
export function findDynamicRead(
  chains: readonly (readonly string[])[],
  roots: Record<string, unknown>,
): DynamicLeaf | undefined {
  for (const read of readNodes(chains, roots)) {
    const leaf = findDynamicLeaf(read.node);
    if (!leaf) continue;
    const own = dynamicNode(read.node, "") !== undefined;
    const path = own
      ? read.path
      : leaf.path.startsWith("[")
        ? `${read.path}${leaf.path}`
        : `${read.path}.${leaf.path}`;
    return { path, what: leaf.what };
  }
  return undefined;
}

/** A rule as {@link ruleReferentReads} reads it: its condition, and where
 *  `this` stands — the resource itself where it iterates nothing. */
export interface RuleReading {
  readonly condition: string;
  readonly in?: string;
}

/**
 * What rules read in each declaration a `resolve:` pointer of `root` crosses
 * into — and, `atRoot`, in the declaration `root` names itself: which of its
 * members hold an expression, the rest of each pointer past a member, and the
 * member each read chain of a condition reaches past a place a pointer may
 * cross — the declaration whole where a chain reads it whole (a bare use, an
 * iteration, a presence test of its members), where a `this` is reached
 * through a repeated group, and where a condition does not parse. Read
 * wherever along a pointer the reference stands, so the same places serve
 * every hop.
 */
export function ruleReferentReads(
  rules: readonly RuleReading[],
  pointers: readonly string[],
  root: string,
  moduleNames?: ReadonlySet<string>,
  atRoot = false,
): ReferentReads {
  const crossings: string[][] = atRoot ? [[]] : [];
  for (const pointer of pointers) {
    const segments = pointerSegments(pointer) ?? [];
    for (let j = 1; j <= segments.length; j++) crossings.push(segments.slice(0, j));
  }
  const places = new Map<string, readonly (string | number)[]>();
  const read = (keys: readonly (string | number)[]) => places.set(JSON.stringify(keys), keys);
  const meets = (a: string, b: string) => a === "*" || b === "*" || a === b;
  const wildcard = (segment: string) => (segment === INDEX_SEGMENT || segment === EACH_SEGMENT ? "*" : segment);
  for (const rule of rules) {
    const compiled = compileRuleCondition(rule.condition, moduleNames);
    // An unparseable condition is refused at the kind: it reads nothing.
    if ("reason" in compiled) continue;
    let item: string[] = [];
    if (rule.in !== undefined) {
      const steps = parseRulePointer(rule.in);
      item = steps ? steps.map((step) => (step.kind === "key" ? step.key : "*")) : [];
    }
    for (const chain of compiled.chains) {
      const base = chain[0] === root ? [] : chain[0] === "this" ? item : null;
      if (base === null) continue;
      let path = [...base, ...chain.slice(1).map(wildcard)];
      const presence = path[path.length - 1] === PRESENCE_SEGMENT;
      if (presence) path = path.slice(0, -1);
      for (const crossing of crossings) {
        const shared = Math.min(path.length, crossing.length);
        if (!path.slice(0, shared).every((segment, i) => meets(segment, crossing[i]!))) continue;
        const rest = path.slice(crossing.length);
        if (path.length <= crossing.length) return READS_WHOLE;
        if (rest[0] === "*") continue;
        read(placeAt([], `/${rest.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`));
      }
    }
  }
  for (const keys of pointerPlaces(pointers)) read(keys);
  const out: ReferentPlace[] = [{ kind: "tagged", keys: [] }];
  for (const keys of places.values()) out.push({ kind: "value", keys });
  return () => out;
}

/** What a resource-rule instance reads beside its anchor: the places of its
 *  own declaration its rules read, and — by name — in the declarations each
 *  `resolve:` pointer reaches, the places the rules read there. */
export interface ResourceRuleReads {
  readonly places: readonly ReadKeys[];
  /** The module functions its conditions call, as written. */
  readonly calls: readonly string[];
  readonly targets: readonly { readonly at: ReadKeys; readonly reads: ReferentReads }[];
}

/** The concrete places along a read path: up to its first wildcard, the
 *  collection the wildcard ranges over. */
function concretePrefix(path: readonly string[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (const segment of path) {
    if (segment === "*") break;
    out.push(/^\d+$/.test(segment) ? Number(segment) : segment);
  }
  return out;
}

/**
 * What a kind's resource rules read in the declaration they judge: the places
 * `in:` ranges over and each chain of a condition reaches — a chain through a
 * comprehension's or `cel.bind`'s variable followed to the member it reads, a
 * wildcard reading the collection it ranges over, `this` the place `in:` names
 * (a repeated group's list) — a declaration whole only for a root read
 * (`self` itself, or an `in:` ranging over the root), and the reference place
 * of each `resolve:` pointer with the places read past it.
 */
export function resourceRuleReads(rules: readonly ResourceRule[], moduleNames?: ReadonlySet<string>): ResourceRuleReads {
  const places = new Map<string, ReadKeys>();
  const read = (keys: ReadKeys) => places.set(JSON.stringify(keys), keys);
  const targets: { at: ReadKeys; reads: ReferentReads }[] = [];
  const calls = new Set<string>();
  for (const rule of rules) {
    let item: string[] = [];
    if (rule.in !== undefined) {
      const steps = parseRulePointer(rule.in);
      item = steps ? steps.map((step) => (step.kind === "key" ? step.key : "*")) : [];
      read(concretePrefix(item));
    }
    const compiled = compileRuleCondition(rule.condition, moduleNames);
    if (!("reason" in compiled)) {
      for (const call of compiled.calls) calls.add(call);
      for (const member of compiled.rootPresence) read([member]);
      for (const chain of compiled.chains) {
        const base = chain[0] === "self" ? [] : chain[0] === "this" ? item : undefined;
        if (base === undefined) continue;
        let path = [...base, ...chain.slice(1).map((segment) => (segment === INDEX_SEGMENT || segment === EACH_SEGMENT ? "*" : segment))];
        if (path[path.length - 1] === PRESENCE_SEGMENT) path = path.slice(0, -1);
        // A test on the root's keys is read member by member above.
        if (chain[0] === "self" && chain.length === 2 && chain[1] === PRESENCE_SEGMENT) continue;
        read(concretePrefix(path));
      }
    }
    for (const pointer of rule.resolve ?? []) {
      const at = crossingPlace(pointer);
      read(at);
      targets.push({ at, reads: ruleReferentReads([rule], [pointer], "self") });
    }
  }
  const all = [...places.values()];
  return {
    places: all.filter((keys) => !all.some((other) => other !== keys && other.length < keys.length && other.every((key, i) => String(key) === String(keys[i])))),
    calls: [...calls],
    targets,
  };
}
