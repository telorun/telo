/**
 * The single reader for `x-telo-referrer-rules` — a kind declaring, as data,
 * what must be true of whoever REFERENCES one of its resources.
 *
 * `x-telo-resource-rules` relates the fields of one resource; this relates a
 * resource to the one that reached it. `Http.Reference` renders the OpenAPI
 * document its server collects, so a server mounting it without an `openapi:`
 * block has nothing to render — a disagreement neither kind can state alone,
 * and one that otherwise surfaces only at boot, after the port is bound.
 *
 * Declared by the kind that HAS the requirement, never by the kind that must
 * satisfy it. That is what lets a third-party mount carry its own requirement
 * without `Http.Server` knowing the kind exists — and it is what keeps the rule
 * free of a kind literal on the subject side, where the spelling would be the
 * consumer's import alias rather than anything the rule author controls.
 *
 * The CEL scope is `self` (the declaring resource) and `referrer` (the one that
 * references it) — with `resolve:`, the referrer with the reference slots it
 * names replaced by the declarations they name, one level deep. Deliberately NOT `this`: in a resource rule `this` is an
 * ELEMENT of a collection, and binding it to a whole foreign manifest would give
 * one word two meanings across the two families.
 *
 * Lenient by design, the `ref-slot.ts` precedent: anything unreadable here reads
 * as absent, and `validate-referrer-rules.ts` is the strict half that reports it.
 *
 * Browser-safe: no Node built-ins.
 */
import { celSourceOf, pointerSegments, ruleReferentReads, type ResourceRuleSeverity } from "./resource-rule.js";
import {
  crossingPlace,
  placeAt,
  type ReadPlace,
  type ReadReporter,
  type ReferentPlace,
  type ReferrerReads,
} from "./read-place.js";
import type { ResourceDefinition } from "@telorun/sdk";
import { authorSchemaChain, type DefResolver } from "./extends-resolution.js";
import { REFERRER_RULES_ANNOTATION, ruleIdentity } from "./rule-inheritance.js";

export { REFERRER_RULES_ANNOTATION };

export interface ReferrerRule {
  /**
   * Kind the referring resource must be for this rule to apply, in the
   * alias-qualified grammar `extends:` and `x-telo-ref` use — canonicalized in
   * the declaring module's scope at registration, so evaluation never sees an
   * alias. Absent = any referrer, which conflates "references me" with the
   * relation the rule is about, so a kind should write it.
   */
  readonly referrer?: string;
  /**
   * JSON Pointer to a collection OF THE REFERRER to resolve — the binding that
   * lets a rule state a relation between SIBLING declarations, which neither a
   * resource rule (one resource) nor a plain referrer rule (a pair joined by one
   * reference) can reach.
   *
   * Declaring it binds `peers` (the collection's OTHER entries) and `entry` (my
   * own), and makes the rule evaluate once per entry rather than once per
   * referrer: a rule reading `entry` is about the entry, and a resource listed
   * twice has two entries to answer for.
   *
   * Entries bind AS WRITTEN with the references *inside them* resolved one level
   * — `p` is the declaration where the entry is a bare `!ref`, `p.mount` is the
   * declaration with `p.prefix` beside it where it is not. Nothing is guessed
   * from the item schema and there is no second pointer to write.
   */
  readonly peers?: string;
  /** JSON Pointers to the REFERRER kind's own reference slots whose
   *  declarations `referrer` reads in place of the references, resolved one
   *  level — the resource-rule `resolve:`, pointed at the referrer. */
  readonly resolve?: readonly string[];
  /** JSON Pointers to THIS kind's own reference slots whose declarations `self`
   *  reads in place of the references — the same view, pointed at `self`. */
  readonly resolveSelf?: readonly string[];
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The annotation exactly as written, for the strict half. `undefined` when the
 *  kind declares none; a non-array is returned as-is so the shape can be
 *  reported rather than silently skipped. */
export function readRawReferrerRules(schema: unknown): unknown {
  if (!isObject(schema)) return undefined;
  return schema[REFERRER_RULES_ANNOTATION];
}

/** Every rule this kind declares that is well-formed enough to run. */
export function readReferrerRules(schema: unknown): ReferrerRule[] {
  const raw = readRawReferrerRules(schema);
  if (!Array.isArray(raw)) return [];
  const rules: ReferrerRule[] = [];
  raw.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const condition = celSourceOf(entry.condition);
    const { code, message, referrer, peers } = entry;
    if (!condition || typeof code !== "string" || typeof message !== "string") return;
    if (code.length === 0 || message.length === 0) return;
    if (referrer !== undefined && typeof referrer !== "string") return;
    if (peers !== undefined && typeof peers !== "string") return;
    const { resolve, resolveSelf } = entry;
    const pointers = (value: unknown) =>
      value === undefined ||
      (Array.isArray(value) && value.every((p) => typeof p === "string" && pointerSegments(p)));
    if (!pointers(resolve) || !pointers(resolveSelf)) return;
    if (entry.severity !== undefined && entry.severity !== "warning" && entry.severity !== "error") {
      return;
    }
    rules.push({
      ...(referrer === undefined ? {} : { referrer }),
      ...(peers === undefined ? {} : { peers }),
      ...(resolve === undefined ? {} : { resolve: resolve as string[] }),
      ...(resolveSelf === undefined ? {} : { resolveSelf: resolveSelf as string[] }),
      condition,
      code,
      message,
      severity: entry.severity === "warning" ? "warning" : "error",
      index,
    });
  });
  return rules;
}

/** The referrer rules one definition of an `extends` chain declares itself. */
export interface DeclaredReferrerRules {
  readonly declarer: ResourceDefinition;
  readonly rules: readonly ReferrerRule[];
}

/** The referrer rules a kind's resources are judged by, grouped by declaring
 *  definition, ancestors first — the resource-rule twin
 *  (`declaredResourceRules`), a rule's identity its code under its filter. */
export function declaredReferrerRules(
  definition: ResourceDefinition,
  resolve: DefResolver,
): DeclaredReferrerRules[] {
  const seen = new Set<string>();
  const out: DeclaredReferrerRules[] = [];
  for (const declarer of authorSchemaChain(definition, resolve)) {
    const rules = readReferrerRules(declarer.schema).filter((rule) => !seen.has(ruleIdentity(REFERRER_RULES_ANNOTATION, rule)!));
    for (const rule of rules) seen.add(ruleIdentity(REFERRER_RULES_ANNOTATION, rule)!);
    if (rules.length > 0) out.push({ declarer, rules });
  }
  return out;
}

/** True when this node carries the annotation — the recognizer the schema-kind
 *  canonicalization walk tests, so shape knowledge stays in this file. */
export function hasReferrerRules(node: Record<string, unknown>): boolean {
  return Array.isArray(node[REFERRER_RULES_ANNOTATION]);
}

/**
 * Rewrite each rule's `referrer:` kind through `rewrite`, in place.
 *
 * The mirror of `rewriteRequiresZoneKind`: the alias→canonical rule lives in
 * `resolve-schema-ref-kinds.ts` and the shape lives here, so a filter is
 * canonical everywhere downstream and a name that resolves to nothing is
 * reported once, at the kind that wrote it. A rewrite returning `undefined`
 * leaves the value as written — the caller reports it.
 */
export function rewriteReferrerRuleKinds(
  node: Record<string, unknown>,
  rewrite: (kind: string) => string | undefined,
): void {
  const raw = node[REFERRER_RULES_ANNOTATION];
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.referrer !== "string") continue;
    const rewritten = rewrite(entry.referrer);
    if (rewritten !== undefined) entry.referrer = rewritten;
  }
}

const referrerReadsOf = new WeakMap<object, ReferrerReads>();

/** What the rules on `node` read in each referrer: the members their conditions
 *  read off `referrer`, and the slots their `resolve:` pointers and the
 *  collection their `peers:` pointer name. */
function referrerReads(node: Record<string, any>, rules: readonly ReferrerRule[]): ReferrerReads {
  const known = referrerReadsOf.get(node);
  if (known) return known;
  const pointers = rules.flatMap((rule) => rule.resolve ?? []);
  const chains = ruleReferentReads(rules, pointers, "referrer", undefined, true);
  const own: ReferentPlace[] = [
    ...pointers.map((pointer): ReferentPlace => ({ kind: "value", keys: crossingPlace(pointer) })),
    ...rules.flatMap((rule): ReferentPlace[] =>
      rule.peers !== undefined ? [{ kind: "value", keys: placeAt([], rule.peers) }] : [],
    ),
  ];
  const reads: ReferrerReads = (referrer) => [...chains(referrer), ...own];
  referrerReadsOf.set(node, reads);
  return reads;
}

/** What `x-telo-referrer-rules` reads: in every referrer what the rules read
 *  there, the resource itself, and in each declaration its `resolveSelf:`
 *  pointers reach through its reference slots, what the rules read there. */
export const referrerRulesReads: ReadReporter = ({ node }) => {
  const rules = readReferrerRules(node);
  const out: ReadPlace[] = [{ kind: "referrers", reads: referrerReads(node, rules) }, { kind: "value", keys: [] }];
  for (const rule of rules) {
    if (!rule.resolveSelf?.length) continue;
    const reads = ruleReferentReads([rule], rule.resolveSelf, "self");
    for (const pointer of rule.resolveSelf) out.push({ kind: "reference", keys: crossingPlace(pointer), transitive: true, reads });
  }
  return out;
};
