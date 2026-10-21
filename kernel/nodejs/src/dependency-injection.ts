import { ResourceInstance, RuntimeError } from "@telorun/sdk";
import { isNeedFulfilment } from "./need-fulfilment.js";

/** One concrete reference site: the value written there and where it sits. */
export interface InjectionSite {
  data: unknown;
  holder?: Record<string, unknown> | unknown[];
  key?: string | number;
}

/**
 * The live instance a `{ name, alias? }` reference names — the lookup Phase-5
 * injection substitutes with, and a native function's data site is delivered
 * through. A non-`Self` alias is a cross-module reference into an import's
 * published exports; if that import hasn't finished init() yet the instance is
 * absent, so this throws to defer the resource to a later pass of the
 * multi-pass init loop (which catches and retries) rather than leaving the ref
 * unresolved. A LOCAL ref that names a resource registered in this context but
 * not yet initialized is deferred the same way — create-success order does not
 * always match init order (e.g. a globally-registered controller lets a
 * dependent create before its dependency's controller has loaded), so injection
 * can run before the dependency inits. Without this defer the slot would be left
 * unresolved and surface as a runtime ERR_RESOURCE_NOT_INVOKABLE. A local ref
 * that names nothing pending resolves to undefined.
 */
export function resolveReference(
  ref: { name: string; alias?: string },
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
  isPending?: (name: string) => boolean,
): ResourceInstance | undefined {
  const alias = ref.alias;
  const instance = getInstance(ref.name, alias);
  if (!instance && alias && alias !== "Self") {
    throw new RuntimeError(
      "ERR_CROSS_MODULE_REF_PENDING",
      `Cross-module reference '${alias}.${ref.name}' is not available yet (import not initialized)`,
    );
  }
  if (!instance && (!alias || alias === "Self") && isPending?.(ref.name)) {
    throw new RuntimeError(
      "ERR_LOCAL_REF_PENDING",
      `Local reference '${ref.name}' is registered but not initialized yet (deferring to a later init pass)`,
    );
  }
  // The identity is NOT stamped here. It is stamped at `create()`, the single
  // instance-production site, which is also the only point where an instance
  // and the context that DECLARED it are both in hand — here the context is
  // the CONSUMER's, so a declaration site derived at this point would name
  // whoever referenced the resource. A second write-once stamp competing for
  // the same property would silently decide that by init order.
  return instance;
}

/**
 * Phase-5 substitution at ONE concrete reference site (the analyzer's reach
 * enumerates them): a `{kind, name}` reference there is replaced in place with
 * the live ResourceInstance `getInstance` returns. A value that is not a
 * reference (an instance already substituted, a value branch) is left as is, as
 * is a reference `getInstance` does not know.
 */
export function injectAtSite(
  site: InjectionSite,
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
  isPending?: (name: string) => boolean,
): void {
  const ref = site.data;
  if (!site.holder || !ref || typeof ref !== "object" || Array.isArray(ref)) return;
  const candidate = ref as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || typeof candidate.name !== "string") return;
  const instance = resolveReference(
    {
      name: candidate.name,
      ...(typeof candidate.alias === "string" ? { alias: candidate.alias } : {}),
    },
    getInstance,
    isPending,
  );
  // A need's fulfilment stays a reference: a controller opens it through
  // `ctx.resolveNeed`, never as an instance it holds.
  if (instance && !isNeedFulfilment(instance)) {
    (site.holder as Record<string | number, unknown>)[site.key!] = instance;
  }
}
