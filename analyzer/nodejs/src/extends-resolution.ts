import type { ResourceDefinition } from "@telorun/sdk";
import { mergeTypeSchemas } from "@telorun/sdk";

/** Resolves a kind string (canonical or alias form, depending on the caller's
 *  registry) to its `Telo.Definition` / `Telo.Abstract`, or undefined. */
export type DefResolver = (kind: string) => ResourceDefinition | undefined;

/** The template-body / controller fields a definition may carry. Kept local
 *  because `ResourceDefinition` intentionally types only the stable surface;
 *  template bodies are read structurally. */
interface DefinitionBody {
  extends?: string;
  capability?: string;
  controllers?: unknown[];
  invoke?: unknown;
  run?: unknown;
  provide?: unknown;
  mount?: unknown;
  resources?: unknown[];
  base?: Record<string, unknown>;
  schema?: Record<string, any>;
}

const body = (def: ResourceDefinition | undefined): DefinitionBody =>
  (def ?? {}) as unknown as DefinitionBody;

/** The definition a given definition directly `extends`, or undefined when it
 *  extends nothing / the target can't be resolved. */
export function resolveParent(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): ResourceDefinition | undefined {
  const ext = body(def).extends;
  if (typeof ext !== "string" || ext.length === 0) return undefined;
  return resolve(ext);
}

/** The `extends` ancestor chain, nearest-first, excluding `def` itself.
 *  Cycle-guarded so a malformed self/mutual `extends` can't loop forever. */
export function ancestorChain(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): ResourceDefinition[] {
  const chain: ResourceDefinition[] = [];
  const seen = new Set<ResourceDefinition>();
  let cur = resolveParent(def, resolve);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = resolveParent(cur, resolve);
  }
  return chain;
}

/** True when a definition carries its own controller (`controllers:`) or a
 *  template body (`invoke:` / `run:` / `provide:` / `mount:` / `resources:`). */
export function hasOwnControllerOrTemplate(def: ResourceDefinition | undefined): boolean {
  const d = body(def);
  return !!(
    (d.controllers && d.controllers.length) ||
    d.invoke ||
    d.run ||
    d.provide ||
    d.mount ||
    d.resources
  );
}

/** The nearest concrete ancestor that provides a controller (own `controllers:`
 *  or a template body) — the definition whose controller an inherited child
 *  delegates to. Undefined when no controller-bearing concrete ancestor exists. */
export function controllerBearingAncestor(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): ResourceDefinition | undefined {
  for (const a of ancestorChain(def, resolve)) {
    if (a.kind === "Telo.Abstract") continue;
    if (hasOwnControllerOrTemplate(a)) return a;
  }
  return undefined;
}

/** True when this definition inherits its controller by delegation: it declares
 *  `extends`, has no own controller/template body, and its nearest concrete
 *  ancestor is controller-bearing. */
export function isInheritedDelegation(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): boolean {
  if (!body(def).extends || hasOwnControllerOrTemplate(def)) return false;
  return controllerBearingAncestor(def, resolve) !== undefined;
}

/** The effective (possibly inherited) capability: the nearest self-or-ancestor
 *  that declares a `capability`. Undefined when none in the chain does. */
export function inheritedCapability(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): string | undefined {
  if (body(def).capability) return body(def).capability;
  for (const a of ancestorChain(def, resolve)) {
    if (body(a).capability) return body(a).capability;
  }
  return undefined;
}

/** The author-facing schema for a definition:
 *  - with `base:` present → the definition's **own** schema (the parent's config
 *    fields are internal, set solely through `base:`).
 *  - without `base:` but with `extends` → `merge(parent-effective, own)` (a pure
 *    additive extension; child overrides on key conflicts), reusing the same
 *    `mergeTypeSchemas` that `Type.JsonSchema.extends` uses.
 *  - no `extends` → the own schema unchanged. */
export function effectiveAuthorSchema(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): Record<string, any> {
  const own = (body(def).schema ?? {}) as Record<string, any>;
  const parent = resolveParent(def, resolve);
  if (!parent) return own;
  if (body(def).base) return own;
  const parentSchema = effectiveAuthorSchema(parent, resolve);
  return mergeTypeSchemas([parentSchema, own]) as Record<string, any>;
}
