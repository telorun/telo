import { resolveRequest, type AddressUnresolvedError, type Resolution } from "./address-wire.js";
import type { Binding } from "./bindings.js";
import type { ErrorSpec } from "./ui-error.js";

/** Where a collection's list endpoint is, as the page document carries it: a
 *  literal app-relative path, or a template whose `{name}` segments `pathParams` fills. */
export type BasePath = string | { path: string; pathParams: Record<string, Binding> };

/**
 * A collection's path over the roots in scope — `params` and `query`, a source
 * having no row: the literal as written, or the template filled as a request
 * target is. One that does not resolve sends nothing; it is reported once in
 * the console.
 */
export function resolveBasePath(basePath: BasePath, roots: Readonly<Record<string, unknown>>, where: string): Resolution {
  if (typeof basePath === "string") return { ok: true, address: basePath };
  return resolveRequest({ path: { value: basePath.path }, pathParams: basePath.pathParams, queryParams: {} }, roots, where);
}

/** What a node draws for an address that does not resolve: the error node's spec. */
export const addressFailure = (error: AddressUnresolvedError): ErrorSpec => ({ type: "error", code: error.code, message: error.message });

/** What a node draws for a path that does not resolve; nothing for one that does. */
export const unresolvedFailure = (resolution: Resolution): ErrorSpec | undefined => (resolution.ok ? undefined : addressFailure(resolution.error));
