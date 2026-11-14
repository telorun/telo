import { getRefIdentity, refSentinelTarget, RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { AddressSpec } from "./address-expansion.js";
import type { Binding } from "./row-binding.js";

/** An address as its author wrote it: a literal, or a path with its parameters.
 *  An accessor member arrives as a binding; `path` may also be a page. */
export type AddressConfig =
  | string
  | {
      path: unknown;
      pathParams?: Record<string, Binding> | null;
      queryParams?: Record<string, Binding> | null;
    };

const isBinding = (value: unknown): value is Binding => {
  const candidate = value as { root?: unknown; path?: unknown; value?: unknown } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  return "value" in candidate || (typeof candidate.root === "string" && Array.isArray(candidate.path));
};

type Reference = { name: string; alias?: string };

/** What a written page reference names: a resolved reference, a `!ref` sentinel, or a declaration's identity. */
export function referenceOf(value: unknown): Reference | undefined {
  const written = value as { __ref?: unknown; name?: unknown; alias?: unknown } | null;
  if (written && typeof written === "object" && written.__ref === true && typeof written.name === "string") {
    return { name: written.name, ...(typeof written.alias === "string" ? { alias: written.alias } : {}) };
  }
  const sentinel = refSentinelTarget(value);
  if (sentinel) return sentinel;
  const identity = written && typeof written === "object" ? getRefIdentity(written as object) : undefined;
  return identity ? { name: identity.name } : undefined;
}

/** A page as its declaration says: its path, and its title as written. */
export interface DeclaredPage {
  path: string;
  title?: unknown;
}

/**
 * The page a reference names, read from its declaration: a page is named,
 * never held, so a page may place a link to itself and two pages may name
 * each other.
 */
export function declaredPage(value: unknown, ctx: ResourceContext, where: string): DeclaredPage {
  const reference = referenceOf(value);
  const lookup = ctx.resolveDeclaredManifest?.bind(ctx);
  if (!lookup) {
    throw new RuntimeError(
      "ERR_CONTROLLER_HOST_INCOMPATIBLE",
      `${where}: this host cannot read declarations, which resolving a page reference to its path needs.`,
    );
  }
  const page = reference && (lookup(reference.name, reference.alias) as { path?: unknown; title?: unknown } | undefined);
  if (typeof page?.path !== "string") {
    throw new RuntimeError(
      "ERR_REF_UNRESOLVED",
      `${where}: '${reference?.name ?? "the value"}' names no page with a 'path'. Point it at a Ui.Page.`,
    );
  }
  return { path: page.path, ...(page.title == null ? {} : { title: page.title }) };
}

/**
 * An address or request target as a renderer receives it, every member present:
 * a literal string a literal path, a page reference that page's own path, a
 * chain data, and the parameter maps empty when omitted.
 */
export function addressSpec(address: AddressConfig, ctx: ResourceContext, where: string): AddressSpec {
  if (typeof address === "string") return { path: { value: address }, pathParams: {}, queryParams: {} };
  const reference = referenceOf(address.path) ? address.path : (address.path as { value?: unknown } | null)?.value;
  let path: Binding;
  if (referenceOf(reference)) path = { value: declaredPage(reference, ctx, where).path };
  else if (isBinding(address.path)) path = address.path;
  else path = { value: address.path };
  return { path, pathParams: { ...(address.pathParams ?? {}) }, queryParams: { ...(address.queryParams ?? {}) } };
}
