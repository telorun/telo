import type { ResourceManifest } from "@telorun/sdk";
import { KERNEL_BUILTINS } from "./builtins.js";
import { kindDeclarationOf } from "./kind-declaration.js";
import { kindDocumentIn, type LoadedKindScope } from "./loaded-kind-scope.js";
import type { LoadedModule, ScopeHolderStep } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { isScopeMember } from "./scope-declarations.js";

/**
 * The `Telo.Import` documents a module declares as SCOPE MEMBERS — in an
 * `x-telo-scope` array of a top-level declaration, or of a member of one, at any
 * depth — read over a loaded graph before any registry exists, each holder's
 * kind resolved through its module's own import edges (a built-in `Telo.<Kind>`
 * from the built-in vocabulary). Which fields are scopes is the kind's schema's
 * to say, never an array's shape.
 *
 * Such an import is a module instance of its own: its path is the importer's,
 * one segment per holder from the module's top level down, then the member's
 * name ({@link scopedInstancePath}).
 *
 * Browser-safe.
 */

export interface ScopedImportSite {
  /** The member, as the declaring file holds it. */
  readonly member: ResourceManifest;
  readonly alias: string;
  /** The holders from the top level down; the last holds the member. */
  readonly holders: readonly ScopeHolderStep[];
  /** The top-level holder's kind, as written. */
  readonly holderKind: string;
}

/** The member's place inside its top-level holder (`with[0]`, `with[1].with[0]`). */
export function scopedMemberPath(holders: readonly ScopeHolderStep[]): string {
  return holders.map((h, i) => `${i === 0 ? "" : "."}${h.field}[${h.index}]`).join("");
}

/** The instance path of a scoped import reached from an instance at `importer`. */
export function scopedInstancePath(
  importer: readonly string[],
  holders: readonly ScopeHolderStep[],
  alias: string,
): string[] {
  return [...importer, ...holders.map((h) => h.name), alias];
}

/** The named top-level scope fields of a schema: a property of the root, or of
 *  a root variant, carrying `x-telo-scope` directly or through a local `$ref`.
 *  Read here rather than through the reference reach, which is memoized per
 *  schema node and must not see a kind's schema before its analysis
 *  canonicalizes it. */
function scopeFieldsOfSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const root = schema as Record<string, any>;
  const local = (node: unknown, depth = 0): Record<string, any> | undefined => {
    if (!node || typeof node !== "object" || depth > 16) return undefined;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return node as Record<string, any>;
    let target: unknown = root;
    for (const key of ref.slice(2).split("/")) {
      target = (target as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return local(target, depth + 1);
  };
  const out: string[] = [];
  const objects = [local(root), ...["anyOf", "oneOf", "allOf"].flatMap((k) => (Array.isArray(root[k]) ? root[k] : []).map((b: unknown) => local(b)))];
  for (const object of objects) {
    const properties = object?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const [field, node] of Object.entries(properties as Record<string, unknown>)) {
      const resolved = local(node);
      const scoped = (node as { "x-telo-scope"?: unknown } | undefined)?.["x-telo-scope"] ?? resolved?.["x-telo-scope"];
      if (scoped !== undefined && !out.includes(field)) out.push(field);
    }
  }
  return out;
}

/** The scope fields of `kind` written in `mod`, following a merge-form `extends`. */
function scopeFieldsOf(
  graph: LoadedKindScope,
  mod: LoadedModule,
  kind: string,
  seen: Set<object> = new Set(),
): string[] {
  if (kind.startsWith("Telo.")) {
    const name = kind.slice("Telo.".length);
    const builtin = KERNEL_BUILTINS.find((d) => d.kind === "Telo.Definition" && d.metadata.name === name);
    return scopeFieldsOfSchema(builtin?.schema);
  }
  const found = kindDocumentIn(graph, mod, kind);
  if (!found || seen.has(found.doc)) return [];
  seen.add(found.doc);
  const definition = kindDeclarationOf(found.doc) as
    | { schema?: unknown; extends?: unknown; base?: unknown }
    | undefined;
  if (!definition) return [];
  const own = scopeFieldsOfSchema(definition.schema);
  if (typeof definition.extends !== "string" || definition.base !== undefined) return own;
  const inherited = scopeFieldsOf(graph, found.module, definition.extends, seen);
  return [...own, ...inherited.filter((f) => !own.includes(f))];
}

/** Every scoped `Telo.Import` among `manifests`, the top-level documents of one
 *  file of `mod`, in document order. */
export function scopedImportsOf(
  graph: LoadedKindScope,
  mod: LoadedModule,
  manifests: readonly unknown[],
): ScopedImportSite[] {
  const out: ScopedImportSite[] = [];
  const fields = new Map<string, string[]>();
  const fieldsOf = (kind: string): string[] => {
    let known = fields.get(kind);
    if (!known) fields.set(kind, (known = scopeFieldsOf(graph, mod, kind)));
    return known;
  };
  const visit = (holder: ResourceManifest, holders: ScopeHolderStep[], holderKind: string): void => {
    for (const field of fieldsOf(holder.kind as string)) {
      const array = (holder as unknown as Record<string, unknown>)[field];
      if (!Array.isArray(array)) continue;
      array.forEach((entry, index) => {
        if (!isScopeMember(entry)) return;
        const chain = [...holders, { name: holder.metadata!.name as string, field, index }];
        if (entry.kind === "Telo.Import") {
          out.push({ member: entry, alias: entry.metadata.name, holders: chain, holderKind });
        } else if (!kindDeclarationOf(entry) && !isModuleKind(entry.kind)) {
          visit(entry, chain, holderKind);
        }
      });
    }
  };
  for (const m of manifests) {
    const doc = m as ResourceManifest | undefined;
    if (!doc || typeof doc.kind !== "string" || typeof doc.metadata?.name !== "string") continue;
    if (doc.kind === "Telo.Import" || isModuleKind(doc.kind) || kindDeclarationOf(doc)) continue;
    visit(doc, [], doc.kind);
  }
  return out;
}
