import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ModuleScopes } from "./alias-resolver.js";
import { moduleAliasScope } from "./module-alias-scope.js";

/**
 * A `Telo.Definition`'s `resources:` entries — the bodies a kind writes for
 * ANOTHER kind — read as what they are: declarations of that other kind.
 *
 * The consequence is the whole point. CEL inside such a body used to be typed in
 * the ENCLOSING definition's scope, against one fixed permissive context
 * (`self`, plus open `request` / `result` / `steps` / `error`). So `inputs` and
 * `item` were undefined wherever the nested kind declares them, while `error`
 * was offered everywhere regardless of whether a `catch:` was in scope — a body
 * of more than one dispatch was unwritable, which is why no standard-library
 * template has one.
 *
 * Resolving through the nested kind's OWN annotations — its `x-telo-context`
 * regions, its step body, its error branches — makes a nested declaration answer
 * exactly as the same declaration written at the top level does, with `self`
 * merged in from the enclosing definition's `schema:`.
 *
 * Browser-safe.
 */
export interface TemplateBody {
  /** Concrete path prefix of this entry (`resources[0]`), as CEL sites are
   *  addressed. */
  prefix: string;
  /** JSONPath prefix for context scopes (`$.resources[0]`). */
  scopePrefix: string;
  manifest: ResourceManifest;
  definition: ResourceDefinition | undefined;
}

/** The template bodies a manifest declares — empty for anything that is not a
 *  `Telo.Definition` with a `resources:` array. */
export function templateBodies(
  m: ResourceManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  scopes: ModuleScopes | undefined,
): TemplateBody[] {
  if (m.kind !== "Telo.Definition") return [];
  const bodies = (m as Record<string, unknown>).resources;
  if (!Array.isArray(bodies)) return [];

  // A nested kind is written through the alias scope of the module that DECLARED
  // the definition, never the consumer's — the same rule every other kind
  // resolution in a forwarded manifest follows.
  const scope = moduleAliasScope(m.metadata, aliases, scopes?.aliasesByModule);

  const out: TemplateBody[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const kind = (body as { kind?: unknown }).kind;
    if (typeof kind !== "string") continue;
    const canonical = scope?.resolveKind(kind);
    const definition = registry.resolve(kind) ?? (canonical ? registry.resolve(canonical) : undefined);
    out.push({
      prefix: `resources[${i}]`,
      scopePrefix: `$.resources[${i}]`,
      manifest: body as ResourceManifest,
      definition,
    });
  }
  return out;
}

/** What a definition's dispatch slot names: the `resources:` entry a `!ref` at
 *  `slot` (`invoke` / `provide` / `run` / `mount`) resolves to, with its kind.
 *  The entry is matched by its LITERAL `metadata.name`; a slot holding anything
 *  but a `!ref`, or naming no entry, resolves to nothing — `validate-template-body`
 *  is what reports either. `Self.<entry>` is the explicit self-qualifier. */
export function dispatchTargetOf(
  definition: Record<string, any>,
  slot: string,
): { entry: Record<string, any> | undefined; kind: string; name: string } | undefined {
  const value = definition[slot];
  if (!isRefSentinel(value)) return undefined;
  const source = value.source;
  const name = source.startsWith("Self.") ? source.slice("Self.".length) : source;
  const bodies = definition.resources;
  if (!Array.isArray(bodies)) return undefined;
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    const entry = body as Record<string, any>;
    if (entry.metadata?.name !== name || typeof entry.kind !== "string") continue;
    return { entry, kind: entry.kind, name };
  }
  return undefined;
}

/** True when a CEL path lies at or inside a body's own subtree. */
export function pathInBody(path: string, prefix: string): boolean {
  return (
    path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)
  );
}

/** The body a CEL path belongs to, or undefined for a path in the definition's
 *  own fields. Generic over what the caller keyed to each body — the resolver
 *  carries a step context and an error map, the visitor carries the schema. */
export function bodyForPath<T extends { prefix: string }>(
  bodies: readonly T[],
  path: string,
): T | undefined {
  return bodies.find((b) => pathInBody(path, b.prefix));
}

/** `self` is in scope throughout a template body — it is how the body reaches
 *  the configuration its enclosing kind was given — so it is merged into every
 *  context the nested kind declares, which knows nothing about it. Merged UNDER
 *  the nested kind's own properties: a name the nested kind declares wins, since
 *  that is what its controller will bind. */
export function withTemplateSelf(contextSchema: Record<string, any>): Record<string, any> {
  return {
    ...contextSchema,
    properties: {
      self: { "x-telo-context-from-root": "schema" },
      ...(contextSchema.properties ?? {}),
    },
  };
}
