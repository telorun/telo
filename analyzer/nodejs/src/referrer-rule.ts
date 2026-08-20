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
 * references it). Deliberately NOT `this`: in a resource rule `this` is an
 * ELEMENT of a collection, and binding it to a whole foreign manifest would give
 * one word two meanings across the two families.
 *
 * Lenient by design, the `ref-slot.ts` precedent: anything unreadable here reads
 * as absent, and `validate-referrer-rules.ts` is the strict half that reports it.
 *
 * Browser-safe: no Node built-ins.
 */
import { celSourceOf, type ResourceRuleSeverity } from "./resource-rule.js";

export const REFERRER_RULES_ANNOTATION = "x-telo-referrer-rules";

export interface ReferrerRule {
  /**
   * Kind the referring resource must be for this rule to apply, in the
   * alias-qualified grammar `extends:` and `x-telo-ref` use — canonicalized in
   * the declaring module's scope at registration, so evaluation never sees an
   * alias. Absent = any referrer, which conflates "references me" with the
   * relation the rule is about, so a kind should write it.
   */
  readonly referrer?: string;
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
    const { code, message, referrer } = entry;
    if (!condition || typeof code !== "string" || typeof message !== "string") return;
    if (code.length === 0 || message.length === 0) return;
    if (referrer !== undefined && typeof referrer !== "string") return;
    if (entry.severity !== undefined && entry.severity !== "warning" && entry.severity !== "error") {
      return;
    }
    rules.push({
      ...(referrer === undefined ? {} : { referrer }),
      condition,
      code,
      message,
      severity: entry.severity === "warning" ? "warning" : "error",
      index,
    });
  });
  return rules;
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
