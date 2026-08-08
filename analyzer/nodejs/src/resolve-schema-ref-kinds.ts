import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { rewriteRefSlotKinds } from "./ref-slot.js";
import { hasRequiresZone, rewriteRequiresZoneKind } from "./zone-slot.js";

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
   *  (the default) or an `x-telo-requires-zone` provider kind — the caller
   *  reports the latter as ZONE_PROVIDER_UNRESOLVED. */
  annotation?: "ref" | "zone";
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

/**
 * Rewrites the `x-telo-ref` constraints on one definition doc from the alias
 * form (`KvStore.Store`, `Self.Store`, `Telo.Invocable`) to the canonical
 * `<module>.<Kind>` key the definition registry is keyed by.
 *
 * `resolver` must be the scope of the module that DECLARES the definition, not
 * the consumer's: an imported library names its dependencies by its own aliases.
 * This mirrors how `extends:` and `capability:` are pre-resolved before
 * registration, so the registry never needs module context to answer a ref query.
 *
 * Every constraint that does not canonicalize is returned, tagged with why. That
 * matters more than it looks: an unresolved constraint leaves a string naming no
 * registered kind, and the reference check treats an unknown target as partial
 * context and skips it — so an unreported one would silently let the slot accept
 * anything. The authored value is left in place either way, so a diagnostic
 * quotes what the author actually wrote.
 *
 * An `unknown` result also covers an already-canonical value (`kv-store.Store`
 * names a module, not an alias), which is what keeps the rewrite idempotent —
 * the caller drops those by checking the definition registry once every kind is
 * registered.
 *
 * The walk covers the whole doc rather than a fixed field list: a constraint can
 * sit in `schema`, `inputType`, `outputType`, or a `$defs` entry nested in any of
 * them, and rewriting one that appears in a template body's inline schema is
 * correct too.
 */
export function resolveSchemaRefKinds(
  definition: ResourceManifest,
  resolver: Pick<AliasResolver, "resolveKindResult" | "knownAliases">,
): RefConstraintIssue[] {
  const issues: RefConstraintIssue[] = [];

  const record = (ref: string, path: string, annotation: "ref" | "zone" = "ref"): void => {
    if (isLegacyRefIdentity(ref)) {
      issues.push({ ref, path, manifest: definition, reason: "legacy", annotation });
      return;
    }
    const result = resolver.resolveKindResult(ref);
    if (result.status === "ok") return;
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
  };

  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    const obj = value as Record<string, unknown>;
    if (obj[REF_ANNOTATION] !== undefined) {
      // Shape knowledge stays in `ref-slot.ts`: this pass states only the
      // alias→canonical rule and what to report when it does not apply.
      rewriteRefSlotKinds(obj, (ref) => {
        const result = isLegacyRefIdentity(ref) ? null : resolver.resolveKindResult(ref);
        if (result?.status === "ok") return result.kind;
        record(ref, path);
        return undefined;
      });
    }
    if (hasRequiresZone(obj)) {
      // A zone requirement names its provider kind through the identical
      // alias-qualified grammar, resolved in the same declaring scope — one
      // walk canonicalizes both, so the kernel's `requireZone` and the zone
      // projection never see an alias. An unresolved name is reported like an
      // unresolved ref constraint (the caller maps it to
      // ZONE_PROVIDER_UNRESOLVED); the legacy identity form is not accepted
      // here — the annotation postdates its removal.
      rewriteRequiresZoneKind(obj, (zone) => {
        const result = resolver.resolveKindResult(zone);
        if (result.status === "ok") return result.kind;
        record(zone, `${path}.x-telo-requires-zone`, "zone");
        return undefined;
      });
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key], path ? `${path}.${key}` : key);
    }
  };

  walk(definition, "");
  return issues;
}
