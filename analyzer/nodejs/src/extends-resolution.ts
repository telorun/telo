import type { ResourceDefinition } from "@telorun/sdk";
import { mergeTypeSchemas } from "@telorun/sdk";

/** Resolves a kind string (canonical or alias form, depending on the caller's
 *  registry) to its `Telo.Definition` / `Telo.Abstract`, or undefined.
 *
 *  `from` is the definition the kind was read off. An `extends` alias belongs to
 *  the file that DECLARES the definition, not to whoever is reading it, so a
 *  resolver that walks an inheritance chain across module boundaries must
 *  re-scope at each hop — `from.metadata.module` is what it scopes to. Resolvers
 *  that operate in a single scope ignore the parameter. */
export type DefResolver = (
  kind: string,
  from?: ResourceDefinition,
) => ResourceDefinition | undefined;

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
  status?: Record<string, any>;
  inputType?: unknown;
  outputType?: unknown;
  inputs?: unknown;
  result?: unknown;
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
  return resolve(ext, def);
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

/**
 * The fields a merge-form inheriting child publishes over its parent's reading.
 *
 * A child that inherits its controller by delegation and declares no `base:` IS
 * the parent instance, so `resources.<child>` is the parent's `snapshot()` — and
 * a field the parent has never heard of would be readable from nowhere. These
 * are exactly those fields: the ones the effective (merged) schema declares that
 * the controller-bearing ancestor's does not.
 *
 * A REDECLARED name is deliberately excluded. Narrowing an inherited field (a
 * description, a pattern, a widget hint) is ordinary in an additive extension and
 * says nothing about publication, while the parent's `snapshot()` is the sole
 * authority on what a parent instance publishes — its normalizations, its
 * deliberate omissions, and its redactions. Republishing such a field from raw
 * config would silently undo a provider's decision to keep it out.
 *
 * Empty for the `base:` form, whose fields are construction inputs consumed by
 * the mapping, and for a child with its own controller, which publishes itself.
 */
export function publishedOwnFields(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): string[] {
  if (body(def).base || !isInheritedDelegation(def, resolve)) return [];
  const ancestor = controllerBearingAncestor(def, resolve);
  if (!ancestor) return [];
  const inherited = new Set(
    Object.keys((effectiveAuthorSchema(ancestor, resolve).properties ?? {}) as object),
  );
  const own = (effectiveAuthorSchema(def, resolve).properties ?? {}) as Record<string, unknown>;
  return Object.keys(own).filter((name) => !inherited.has(name));
}

/** The two directions of a kind's invocation contract. `inputType` is what a
 *  caller sends to `invoke()`; `outputType` is what `invoke()` / `provide()`
 *  returns. */
export type ContractDirection = "inputType" | "outputType";

/**
 * The **nearest declaration** of an invocation contract along the `extends`
 * chain, self first — the raw type-field value, still to be resolved to a schema
 * by the caller (which is what keeps this module free of manifest lookup).
 *
 * Contracts RESOLVE, they never merge. A definition that declares one fully
 * replaces its ancestor's; one that declares none inherits its ancestor's
 * verbatim, at any depth. This is deliberately unlike {@link
 * effectiveAuthorSchema} and {@link effectiveStatusSchema}: construction config
 * and observed state are additive, a call signature is not. Folding a child's
 * required fields into its parent's yields a union no caller can satisfy, and it
 * would reject the very remapping `base:` + `inputs:` exists for — the point of
 * a child declaring a signature is that it accepts something *different*.
 *
 * Substitutability is not weakened by that, because `extends` never carried the
 * dispatch contract: it decides which slots accept a resource. Whether a
 * particular slot may hold a resource whose contract differs from the slot's
 * declared kind is a wiring question, answered per slot by
 * `validate-invocation-contract`'s wiring rule.
 */
export function effectiveContractField(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
  direction: ContractDirection,
): unknown {
  const own = body(def)[direction];
  if (own !== undefined && own !== null) return own;
  for (const a of ancestorChain(def, resolve)) {
    const inherited = body(a)[direction];
    if (inherited !== undefined && inherited !== null) return inherited;
  }
  return undefined;
}

/** The definition in the `extends` chain (self first) that actually DECLARES the
 *  contract for `direction` — the one whose scope its `telo#Type` references
 *  resolve in, and the one a diagnostic should name. Undefined when nothing in
 *  the chain declares it. */
export function contractDeclarer(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
  direction: ContractDirection,
): ResourceDefinition | undefined {
  if (!def) return undefined;
  const own = body(def)[direction];
  if (own !== undefined && own !== null) return def;
  for (const a of ancestorChain(def, resolve)) {
    const inherited = body(a)[direction];
    if (inherited !== undefined && inherited !== null) return a;
  }
  return undefined;
}

/** True when this definition declares its own contract for `direction` while
 *  inheriting the controller that will execute it — the case that REQUIRES a
 *  bridging mapping (`inputs:` for inputs, `result:` for outputs), because the
 *  inherited controller only understands the ancestor's shape. A definition with
 *  its own controller or template body is exempt: its controller *is* the
 *  implementation of whatever it declares. */
export function needsContractMapping(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
  direction: ContractDirection,
): boolean {
  const own = body(def)[direction];
  if (own === undefined || own === null) return false;
  if (hasOwnControllerOrTemplate(def)) return false;
  return controllerBearingAncestor(def, resolve) !== undefined;
}

/** The mapping field that bridges a replaced contract back to the inherited
 *  controller: `inputs:` maps the child's signature onto the parent's call,
 *  `result:` maps the parent's result back to the child's declared output. */
export function mappingFieldFor(direction: ContractDirection): "inputs" | "result" {
  return direction === "inputType" ? "inputs" : "result";
}

/** The observed state a kind reports (`status:`), folded through `extends`:
 *  - with `base:` present → the **parent's** effective status unchanged; the
 *    child delegates to the parent's controller and *is* a parent instance, so
 *    it publishes exactly what the parent publishes.
 *  - without `base:` but with `extends` → `merge(parent-effective, own)`, so a
 *    contract can mandate what its implementations report and an implementation
 *    can add to it.
 *  - no `extends` → the own block unchanged.
 *  Undefined when nothing in the chain declares one — the signal that the kind
 *  has not opted into typed `.status` reads. */
export function effectiveStatusSchema(
  def: ResourceDefinition | undefined,
  resolve: DefResolver,
): Record<string, any> | undefined {
  const own = body(def).status;
  const parent = resolveParent(def, resolve);
  if (!parent) return own;
  const parentStatus = effectiveStatusSchema(parent, resolve);
  if (body(def).base) return parentStatus;
  if (!parentStatus) return own;
  if (!own) return parentStatus;
  return mergeTypeSchemas([parentStatus, own]) as Record<string, any>;
}
