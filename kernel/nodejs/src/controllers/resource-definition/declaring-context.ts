import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { ModuleContext } from "../../module-context.js";

/**
 * The module context a resource's `kind:` is spelled in, when it is not the
 * owning context's module: a configuration an inherited `base:` mapping built
 * names its kind through the aliases of the module that wrote the mapping.
 */
const kindScopes = new WeakMap<object, ModuleContext>();

export function recordKindScope(resource: object, scope: ModuleContext): void {
  kindScopes.set(resource, scope);
}

/**
 * The module context that declares `holder` — a definition in the `extends`
 * chain of the instance's kind, reached through the spelling the instance was
 * written with and then through each definition's own `extends`, so every hop
 * resolves in the module that wrote it. Without `holder`, the context declaring
 * the instance's own kind.
 *
 * A template body, a `base:` mapping and an `inputs:` / `result:` mapping run in
 * the context returned for the definition holding them. Resolved per instance,
 * never captured when the kind was registered: a kind is registered once per
 * kernel, while every isolated import of its library is a context of its own —
 * `A.Greet` and `B.Greet` share a definition and must not share `variables`.
 */
export function declaringContextOf(
  resource: { kind: string; metadata?: { name?: string } },
  ctx: ResourceContext,
  holder?: { metadata?: { name?: string; module?: string } },
): ModuleContext {
  return definitionScopeOf(
    kindScopes.get(resource) ?? (ctx.moduleContext as unknown as ModuleContext),
    resource.kind,
    holder,
    resource.metadata?.name,
  );
}

/** {@link declaringContextOf} for a kind spelled in `spelledIn`. */
export function definitionScopeOf(
  spelledIn: ModuleContext,
  kind: string,
  holder: { metadata?: { name?: string; module?: string } } | undefined,
  resourceName: string | undefined,
): ModuleContext {
  const written = kind;
  const target = holder ? `${holder.metadata?.module}.${holder.metadata?.name}` : undefined;
  const seen = new Set<string>();
  for (;;) {
    const scope = spelledIn.resolveKindScope(kind);
    if (!scope) break;
    const canonical = spelledIn.resolveKind(kind);
    if (target === undefined || canonical === target) return scope;
    if (seen.has(canonical)) break;
    seen.add(canonical);
    const parent = (scope.getDefinition?.(canonical) as { extends?: unknown } | undefined)?.extends;
    if (typeof parent !== "string") break;
    spelledIn = scope;
    kind = parent;
  }
  throw new RuntimeError(
    "ERR_KIND_SCOPE_UNRESOLVED",
    `Kind '${written}' of '${resourceName ?? "<unnamed>"}' resolves to no module ` +
      `that declares ${target ? `'${target}'` : "it"}, so its template body or mapping has no scope to run in.`,
  );
}
