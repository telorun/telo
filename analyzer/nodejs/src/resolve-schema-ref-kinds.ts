import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";

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

  const record = (ref: string, path: string): void => {
    if (isLegacyRefIdentity(ref)) {
      issues.push({ ref, path, manifest: definition, reason: "legacy" });
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
            gate: { module: result.module, exported: result.exported },
          }
        : {
            ref,
            path,
            manifest: definition,
            reason: "unknown",
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
    const ref = obj[REF_ANNOTATION];
    if (typeof ref === "string" && ref) {
      const result = isLegacyRefIdentity(ref) ? null : resolver.resolveKindResult(ref);
      if (result?.status === "ok") obj[REF_ANNOTATION] = result.kind;
      else record(ref, path);
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key], path ? `${path}.${key}` : key);
    }
  };

  walk(definition, "");
  return issues;
}
