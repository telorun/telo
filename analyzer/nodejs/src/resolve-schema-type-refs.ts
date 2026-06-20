import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";

/** Schema-bearing fields on a Telo.Definition / Telo.Type resource. */
const SCHEMA_FIELDS = ["schema", "inputType", "outputType"];

/**
 * Rewrites import-scoped schema references in place. A `$ref` of the form
 * `telo://<authority>/<typeName>` names a `Type.JsonSchema` (or any `Telo.Type`)
 * reached through an import: `telo://Self/<type>` for the declaring module's own
 * type, `telo://<Alias>/<type>` for an imported module's. Each authority is
 * resolved to the owning module's name and the ref is rewritten to the canonical
 * `telo://<module>/<type>` the type registered its schema under.
 *
 * The version lives on the `imports:` entry, never the URI — only the pinned
 * version is loaded, so the canonical id is version-free.
 *
 * Already-canonical refs (authority is a real module name, not an alias) and
 * fragment-bearing built-ins (`telo://manifest#/$defs/ResourceRef`) are left
 * untouched: the former because the authority resolves to nothing, the latter
 * because they don't match the `authority/type` grammar.
 */
export function resolveSchemaTypeRefs(
  resources: ResourceManifest[],
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): void {
  const walk = (value: unknown, resolveAuthority: (authority: string) => string | undefined): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, resolveAuthority);
      return;
    }
    const obj = value as Record<string, unknown>;
    const parsed = parseTeloTypeRef(obj.$ref);
    if (parsed) {
      const module = resolveAuthority(parsed.authority);
      if (module) obj.$ref = canonicalTypeSchemaId(module, parsed.typeName);
    }
    for (const key of Object.keys(obj)) walk(obj[key], resolveAuthority);
  };

  for (const r of resources) {
    const ownModule = (r.metadata as { module?: string } | undefined)?.module;
    const resolver = (ownModule ? aliasesByModule?.get(ownModule) : undefined) ?? aliases;
    const resolveAuthority = (authority: string): string | undefined =>
      authority === "Self" ? ownModule : resolver?.moduleForAlias(authority);
    for (const field of SCHEMA_FIELDS) {
      walk((r as Record<string, unknown>)[field], resolveAuthority);
    }
  }
}
