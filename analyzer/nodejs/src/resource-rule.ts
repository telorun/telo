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
 *  make a rule readable on some paths and invisible on others. */
function isCelNode(value: unknown): value is { source?: unknown } {
  return isObject(value) && (value.__compiled === true || value.__tagged === true);
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

/**
 * Path of the first CEL leaf inside a value, or `undefined` when every leaf is
 * literal. A rule reading an expression would be evaluating a placeholder, so
 * the subject is skipped — and the skip is reported, never silent.
 *
 * Stops at nested inline `{ kind }` declarations for the reason every other walk
 * does: that CEL belongs to the nested kind, evaluated in its own scope.
 */
export function findDynamicLeaf(value: unknown, base = ""): string | undefined {
  if (isObject(value)) {
    if (isCelNode(value)) return base || "(value)";
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
  self: unknown,
  subject: unknown,
): unknown[] {
  const nodes: unknown[] = [];
  for (const chain of chains) {
    const root = chain[0];
    let current: unknown = root === "self" ? self : root === "this" ? subject : undefined;
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
