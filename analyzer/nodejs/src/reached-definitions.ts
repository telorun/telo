/**
 * The template definitions an analysis reads: the entry's own, and every
 * dependency's the entry reaches — a kind one of the entry's declarations
 * names runs it, directly or through an entry of the body of a definition
 * already reached, transitively. Computed from kinds alone, before anything
 * is lifted or solved, so a dependency definition nothing reaches costs
 * nothing. Ownership decides only what is reported; this set is what is read.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { moduleScopedDefResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { ancestorChain } from "./extends-resolution.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { isModuleKind } from "./module-kinds.js";
import { definitionInScope } from "./module-alias-scope.js";
import { TEMPLATE_BODY_FIELDS } from "./template-expansion.js";

export interface ReachedDefinitions {
  /** Whether `definition` — a `Telo.Definition` document — is read. */
  has(definition: ResourceManifest): boolean;
  /** Whether `definition` is the entry's own. */
  isOwn(definition: ResourceManifest): boolean;
}

/** A definition's identity across the document and its registered copy. */
function identityOf(m: { metadata?: unknown }): string {
  const meta = m.metadata as { name?: unknown; module?: unknown } | undefined;
  return JSON.stringify([meta?.module ?? null, meta?.name ?? null]);
}

export function reachedDefinitions(
  declarations: readonly ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  entryModules: ReadonlySet<string>,
): ReachedDefinitions {
  const isOwnModule = (m: { metadata?: unknown }) => {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    return typeof module !== "string" || entryModules.has(module);
  };
  const documents = new Map<string, ResourceManifest>();
  for (const m of declarations) if (m.kind === "Telo.Definition") documents.set(identityOf(m), m);
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, { aliasesByModule, rootModules: entryModules });
  const read = new Set<string>();
  const queue: ResourceManifest[] = [];
  const reach = (definition: ResourceDefinition): void => {
    for (const each of [definition, ...ancestorChain(definition, resolveDef)]) {
      const identity = identityOf(each);
      if (read.has(identity)) continue;
      const document = documents.get(identity);
      if (!document) continue;
      read.add(identity);
      queue.push(document);
    }
  };
  /** Every kind written at or beneath `value`, resolved where `within` is. */
  const kindsIn = (value: unknown, within: ResourceManifest["metadata"]): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) kindsIn(item, within);
      return;
    }
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === "string") {
      const definition = definitionInScope<ResourceDefinition>(defs, kind, within, aliases, aliasesByModule);
      if (definition) reach(definition);
    }
    for (const field of Object.values(value)) kindsIn(field, within);
  };
  for (const m of declarations) {
    if (typeof m.kind !== "string" || !isOwnModule(m) || isModuleKind(m.kind)) continue;
    if (m.kind === "Telo.Definition") {
      read.add(identityOf(m));
      queue.push(m);
      continue;
    }
    if (isKindDocumentOrImport(m)) continue;
    kindsIn(m, m.metadata);
  }
  for (let i = 0; i < queue.length; i++) {
    const definition = queue[i]!;
    // A child without a body of its own runs its ancestor's.
    const parent = (definition as { extends?: unknown }).extends;
    if (typeof parent === "string") {
      const resolved = definitionInScope<ResourceDefinition>(defs, parent, definition.metadata, aliases, aliasesByModule);
      if (resolved) reach(resolved);
    }
    for (const field of TEMPLATE_BODY_FIELDS) {
      kindsIn((definition as Record<string, unknown>)[field], definition.metadata);
    }
  }
  return {
    has: (definition) => read.has(identityOf(definition)),
    isOwn: (definition) => isOwnModule(definition),
  };
}
