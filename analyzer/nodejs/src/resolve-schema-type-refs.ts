import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";

/** Schema-bearing fields on a Telo.Definition / Telo.Type resource. */
const SCHEMA_FIELDS = ["schema", "inputType", "outputType"];

/**
 * Rewrites schema references to their canonical, module-scoped form, in place.
 *
 * A named shape is written with the reference tag — `!ref File` for the declaring
 * module's own, `!ref <Alias>.<File>` for one an imported library exports — which
 * is Telo's ONE reference grammar, and `use: schema` has been in the `x-telo-ref`
 * vocabulary for exactly this relation all along (*names a shape; no runtime
 * instance, no edge*). Phase 2.5 has already turned the tag into `{kind, name,
 * alias?}`; this pass turns that into `{ $ref: "telo:<module>/<type>" }`, the id
 * the type registered its schema under.
 *
 * WHY NORMALIZE RATHER THAN RESOLVE. Substituting the shape itself would inline
 * it, which changes schema identity — the compiled-validator cache is keyed on it
 * — and would make a self-recursive shape inexpressible. Keeping a REFERENCE is
 * what every validator wants, and it is not an AJV concern: a Rust validator
 * wants a registered id just as much. So the tag is the authoring surface and the
 * canonical `$ref` is the internal form, exactly as `resolveRefSentinels` and
 * `resolveSchemaRefKinds` already split authoring sugar from canonical form.
 *
 * ALIAS SCOPE IS WHAT THE CANONICAL FORM CARRIES. The authority is resolved in
 * the DECLARING module's scope, so the id names the owning module and two
 * libraries declaring a shape of the same name stay distinct. A downstream
 * resolver reads the module off the id instead of matching a bare name, which is
 * how an alias used to get silently dropped.
 *
 * The legacy authoring spelling `$ref: "telo://<authority>/<type>"` is resolved
 * the same way, since a published artifact carries it. The version lives on the
 * `imports:` entry, never the URI — only the pinned version is loaded, so the
 * canonical id is version-free. Already-canonical refs and fragment-bearing
 * built-ins (`telo://manifest#/$defs/ResourceRef`) are left untouched: the former
 * because the authority resolves to nothing, the latter because they do not match
 * the `authority/type` grammar.
 */
export function resolveSchemaTypeRefs(
  resources: ResourceManifest[],
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): void {
  const walk = (
    value: unknown,
    resolveAuthority: (authority: string) => string | undefined,
    ownModule: string | undefined,
    // The type field's OWN value is a declared reference slot (`x-telo-ref:
    // Telo.Type`), with its own reference validation and its own editor picker.
    // Only what sits INSIDE it is schema, and only schema is this pass's to
    // canonicalize — rewriting the slot itself would hand the reference checker
    // a shape it is right to reject.
    isSlotRoot: boolean,
  ): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, resolveAuthority, ownModule, false);
      return;
    }
    const obj = value as Record<string, unknown>;
    const parsed = parseTeloTypeRef(obj.$ref);
    if (parsed) {
      const module = resolveAuthority(parsed.authority);
      if (module) obj.$ref = canonicalTypeSchemaId(module, parsed.typeName);
    }
    // A reference the tag left behind. Rewritten in place rather than replaced,
    // so a node that carried siblings (a `title`, a `description`) keeps them —
    // a `$ref` beside other keywords is ordinary JSON Schema.
    const named = resolvedRefInSchema(obj);
    if (named) {
      const module = named.alias === undefined ? ownModule : resolveAuthority(named.alias);
      // An unresolvable alias is left exactly as written: `validateReferences`
      // is what reports a reference that names nothing, and guessing a module
      // here would turn a typo into a `$ref` that resolves to the wrong shape.
      if (module) {
        const canonical = canonicalTypeSchemaId(module, named.name);
        if (isSlotRoot) {
          // At the slot root the reference STAYS a reference — the canonical id
          // is stamped beside it. That is what makes the resolver alias-aware
          // here: it reads the module off the id instead of matching a bare
          // `metadata.name` across a flattened list, where two libraries
          // declaring a shape of the same name collide silently.
          obj.$ref = canonical;
        } else {
          delete obj.kind;
          delete obj.name;
          delete obj.alias;
          obj.$ref = canonical;
        }
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key], resolveAuthority, ownModule, false);
  };

  for (const r of resources) {
    const ownModule = (r.metadata as { module?: string } | undefined)?.module;
    const resolver = (ownModule ? aliasesByModule?.get(ownModule) : undefined) ?? aliases;
    const resolveAuthority = (authority: string): string | undefined =>
      authority === "Self" ? ownModule : resolver?.moduleForAlias(authority);
    for (const field of SCHEMA_FIELDS) {
      walk((r as Record<string, unknown>)[field], resolveAuthority, ownModule, true);
    }
  }
}

/**
 * A resolved `!ref` sitting where a schema belongs, or null.
 *
 * Recognised structurally: Phase 2.5 writes `{kind, name, alias?}` and nothing
 * else, and a node carrying JSON Schema keywords is a schema that happens to be
 * beside one rather than a reference. Being conservative here is the safe
 * direction — a node this declines to rewrite stays a reference for
 * `validateReferences` to judge, while one it rewrote wrongly would silently
 * become a different shape.
 */
function resolvedRefInSchema(
  obj: Record<string, unknown>,
): { name: string; alias?: string } | null {
  if (typeof obj.kind !== "string" || typeof obj.name !== "string") return null;
  for (const key of Object.keys(obj)) {
    // `$ref` is allowed so the pass is idempotent at a slot root, where the id
    // is stamped BESIDE the reference rather than replacing it.
    if (key !== "kind" && key !== "name" && key !== "alias" && key !== "$ref") return null;
  }
  return typeof obj.alias === "string"
    ? { name: obj.name, alias: obj.alias }
    : { name: obj.name };
}
