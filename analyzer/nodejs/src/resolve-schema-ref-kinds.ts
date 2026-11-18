import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { withCoReferrerKinds, withRefSlotKinds } from "./ref-slot.js";
import { REFERRER_RULES_ANNOTATION, hasReferrerRules, withReferrerRuleKinds } from "./referrer-rule.js";
import { hasTextKeys, withTextKeysKinds } from "./text-keys.js";
import { RESOURCE_RULES_ANNOTATION, hasResourceRules, withReachableRuleKinds } from "./resource-rule.js";
import { hasRequiresZone, withRequiresZoneKind } from "./zone-slot.js";

const REF_ANNOTATION = "x-telo-ref";

/** Why an `x-telo-ref` constraint did not canonicalize.
 *
 *  - `legacy`  — the deprecated `<namespace>/<module>#<Kind>` identity form,
 *                still resolved through the identity table.
 *  - `unknown` — the prefix is not an alias in the declaring module's scope: a
 *                typo, a missing `imports:` entry — or a value that was already
 *                canonical, which the caller separates by asking the registry.
 *  - `gated`   — the alias is known and the target owns the kind, but its
 *                `exports.kinds` does not list it. */
export type RefConstraintReason = "legacy" | "unknown" | "gated";

/** An `x-telo-ref` constraint that did not canonicalize. */
export interface RefConstraintIssue {
  /** The constraint string exactly as authored. */
  ref: string;
  /** Dotted path to the annotated schema node within the doc, e.g.
   *  `schema.properties.store`. Points the author at the slot, not just the doc. */
  path: string;
  /** The `Telo.Definition` / `Telo.Abstract` doc that declares the slot. */
  manifest: ResourceManifest;
  reason: RefConstraintReason;
  /** Which annotation carried the unresolved name: an `x-telo-ref` constraint
   *  (the default), an `x-telo-requires-zone` provider kind, or an
   *  `x-telo-referrer-rules` `referrer:` filter — the caller reports those as
   *  ZONE_PROVIDER_UNRESOLVED and REFERRER_RULE_INVALID. */
  annotation?: "ref" | "zone" | "referrer" | "reachable";
  /** For `gated`: the target module and the kinds it does export. */
  gate?: { module: string; exported: string[] };
  /** Aliases the declaring scope does know — the "did you mean" material for
   *  an `unknown` prefix. */
  knownAliases?: string[];
}

/** True for the legacy identity form, which is split on `#` by the identity table. */
export function isLegacyRefIdentity(ref: string): boolean {
  return ref.includes("#");
}

/** The annotations naming a kind: an `x-telo-ref` constraint, the kind its
 *  `callsCoReferrers` names, an `x-telo-requires-zone` provider, an
 *  `x-telo-referrer-rules` `referrer:` filter, an `x-telo-resource-rules`
 *  `reachable.kind` and an `x-telo-text-keys` entry. */
type KindAnnotation = "ref" | "coReferrer" | "zone" | "referrer" | "reachable" | "textKeys";

/** What one kind name maps to — `undefined` keeps it as written. `path` is the
 *  dotted path to the name's place in the document. */
type KindMap = (kind: string, annotation: KindAnnotation, path: string) => string | undefined;

/**
 * `value` with every kind its annotations name mapped through `map`, at any
 * depth — a copy holding the mapped names, sharing every node no name changes
 * beneath, or `value` itself when none does. Never writes to `value`. Each
 * annotation's shape is its own reader's (`with*Kinds`); this walk only finds
 * the nodes carrying one.
 *
 * The walk covers the whole document rather than a fixed field list: a name can
 * sit in `schema`, `inputType`, `outputType`, or a `$defs` entry nested in any of
 * them, and one in a template body's inline schema is mapped too.
 */
function withAnnotationKinds(value: unknown, path: string, map: KindMap): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let items: unknown[] | undefined;
    value.forEach((item, i) => {
      const read = withAnnotationKinds(item, `${path}[${i}]`, map);
      if (read !== item) (items ??= [...value])[i] = read;
    });
    return items ?? value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let node = value as Record<string, unknown>;
  if (node[REF_ANNOTATION] !== undefined) {
    node = withRefSlotKinds(node, (kind) => map(kind, "ref", path));
    node = withCoReferrerKinds(node, (kind) => map(kind, "coReferrer", path));
  }
  if (hasRequiresZone(node)) {
    node = withRequiresZoneKind(node, (kind) => map(kind, "zone", `${path}.x-telo-requires-zone`));
  }
  if (hasReferrerRules(node)) {
    node = withReferrerRuleKinds(node, (kind) => map(kind, "referrer", `${path}.${REFERRER_RULES_ANNOTATION}`));
  }
  if (hasResourceRules(node)) {
    node = withReachableRuleKinds(node, (kind, index) =>
      map(kind, "reachable", `${path}.${RESOURCE_RULES_ANNOTATION}[${index}].reachable.kind`),
    );
  }
  if (hasTextKeys(node)) node = withTextKeysKinds(node, (kind) => map(kind, "textKeys", path));
  let copy = node === value ? undefined : node;
  for (const key of Object.keys(node)) {
    const child = node[key];
    const read = withAnnotationKinds(child, path ? `${path}.${key}` : key, map);
    if (read !== child) (copy ??= { ...node })[key] = read;
  }
  return copy ?? value;
}

/**
 * `definition` with every kind its annotations name canonical — the
 * `<module>.<Kind>` key the definition registry is keyed by — resolved in
 * `resolver`, the scope of the module that DECLARES it (an imported library
 * names its dependencies by its own aliases). A copy sharing every node no name
 * changes beneath, or `definition` itself when none does; the document is never
 * written to. A name that does not resolve keeps the text its author wrote, for
 * {@link refConstraintIssues} to report. Part of the copy the registry holds
 * (`registeredDefinitionCopy`), which is also how a named shape's slots are
 * read; nothing else canonicalizes.
 */
export function withCanonicalAnnotationKinds<T extends object>(
  definition: T,
  resolver: Pick<AliasResolver, "resolveKindResult">,
): T {
  return withAnnotationKinds(definition, "", (kind, annotation) => {
    if (annotation === "ref" && isLegacyRefIdentity(kind)) return undefined;
    const result = resolver.resolveKindResult(kind);
    return result.status === "ok" ? result.kind : undefined;
  }) as T;
}

/**
 * Every kind name on one definition doc that does not canonicalize in
 * `resolver` — the scope of the module that DECLARES the definition — tagged
 * with why, quoting the name as written. The document is read, never written.
 *
 * That matters more than it looks: an unresolved constraint leaves a string
 * naming no registered kind, and the reference check treats an unknown target
 * as partial context and skips it — so an unreported one would silently let the
 * slot accept anything.
 *
 * An `unknown` result also covers an already-canonical value (`acme.Store`
 * names a module, not an alias); the caller drops those by checking the
 * definition registry once every kind is registered. A co-referrer kind and a
 * text-keys entry are reported by their own readers
 * (`X_TELO_REF_INVALID_CALLS_CO_REFERRERS`, `TEXT_KEYS_INVALID`); the legacy
 * identity form is accepted on an `x-telo-ref` constraint alone — every other
 * annotation postdates its removal.
 */
export function refConstraintIssues(
  definition: ResourceManifest,
  resolver: Pick<AliasResolver, "resolveKindResult" | "knownAliases">,
): RefConstraintIssue[] {
  const issues: RefConstraintIssue[] = [];
  withAnnotationKinds(definition, "", (ref, annotation, path) => {
    if (annotation === "coReferrer" || annotation === "textKeys") return undefined;
    if (annotation === "ref" && isLegacyRefIdentity(ref)) {
      issues.push({ ref, path, manifest: definition, reason: "legacy", annotation });
      return undefined;
    }
    const result = resolver.resolveKindResult(ref);
    if (result.status === "ok") return undefined;
    issues.push(
      result.status === "gated"
        ? {
            ref,
            path,
            manifest: definition,
            reason: "gated",
            annotation,
            gate: { module: result.module, exported: result.exported },
          }
        : {
            ref,
            path,
            manifest: definition,
            reason: "unknown",
            annotation,
            knownAliases: resolver.knownAliases(),
          },
    );
    return undefined;
  });
  return issues;
}
