/**
 * How a kind's rules inherit along `extends`. A merge-form child's
 * `x-telo-resource-rules` and `x-telo-referrer-rules` are its ancestors' plus
 * its own, joined along the chain with the ancestors' first: a child adds rules
 * and never removes one, as a subtype's invariant is its parent's conjoined with
 * its own. A rule's identity is unique along the chain — a resource rule's
 * `code`, a referrer rule's `code` under its `referrer:` filter — and each
 * family's strict half refuses a child reusing an inherited one. A `base:`
 * child's author schema is its own, so it inherits no rule.
 *
 * No imports, because `effectiveAuthorSchema` joins through it and is read by
 * every host.
 */

export const RESOURCE_RULES_ANNOTATION = "x-telo-resource-rules";
export const REFERRER_RULES_ANNOTATION = "x-telo-referrer-rules";

export type RuleAnnotation = typeof RESOURCE_RULES_ANNOTATION | typeof REFERRER_RULES_ANNOTATION;

export const RULE_ANNOTATIONS: readonly RuleAnnotation[] = [RESOURCE_RULES_ANNOTATION, REFERRER_RULES_ANNOTATION];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A rule entry's identity along the chain, or `undefined` for an entry with no
 *  code, which its strict half reports. */
export function ruleIdentity(annotation: RuleAnnotation, entry: unknown): string | undefined {
  if (!isObject(entry) || typeof entry.code !== "string") return undefined;
  if (annotation === RESOURCE_RULES_ANNOTATION) return entry.code;
  return `${entry.code}\u0000${typeof entry.referrer === "string" ? entry.referrer : ""}`;
}

/**
 * `inherited` followed by `own`. A non-array side contributes nothing; with no
 * array on either side `own` is returned as written. Each ancestor's rules are
 * joined once by construction: an `inherited` side is its parent's rules
 * already joined along its own chain, and no definition holds a folded schema.
 */
export function joinInheritedRules(inherited: unknown, own: unknown): unknown {
  if (!Array.isArray(own)) return Array.isArray(inherited) ? inherited : own;
  if (!Array.isArray(inherited)) return own;
  return [...inherited, ...own];
}
