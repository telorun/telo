import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { ModuleContext } from "../../module-context.js";

/**
 * The module context a template body or a `base:` mapping runs in: the one that
 * declares the instance's kind, reached through the spelling the instance was
 * written with.
 *
 * Resolved per instance, never captured when the kind was registered: a kind is
 * registered once per kernel, while every isolated import of its library is a
 * context of its own — `A.Greet` and `B.Greet` share a definition and must not
 * share `variables`.
 */
export function declaringContextOf(
  resource: { kind: string; metadata?: { name?: string } },
  ctx: ResourceContext,
): ModuleContext {
  const scope = (ctx.moduleContext as unknown as ModuleContext).resolveKindScope(resource.kind);
  if (!scope) {
    throw new RuntimeError(
      "ERR_KIND_SCOPE_UNRESOLVED",
      `Kind '${resource.kind}' of '${resource.metadata?.name ?? "<unnamed>"}' resolves to no module ` +
        `that declares it, so its template body or 'base:' mapping has no scope to run in.`,
    );
  }
  return scope;
}
