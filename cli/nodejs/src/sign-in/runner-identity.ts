import type { ProtectedResourceMetadata } from "@telorun/runner-protocol";

import { failureCause } from "./request-failure.js";
import { ACCOUNTS_URL_ENV, DPOP_ALGORITHM, withoutTrailingSlashes } from "./sign-in-config.js";
import { SignInError } from "./sign-in-error.js";

/**
 * A resource or issuer URL in the one form two spellings of it are compared in:
 * scheme and host lowercased, a default port dropped, no trailing slash. A value
 * that is not a URL is compared as written.
 */
export function normalizeResourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const pathname = withoutTrailingSlashes(url.pathname);
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export function sameResource(a: string, b: string): boolean {
  return normalizeResourceUrl(a) === normalizeResourceUrl(b);
}

/**
 * Why a runner's advertised identity disagrees with the configuration, or
 * `undefined` when it agrees: its `resource` is the runner telo connected to, the
 * configured issuer is among its `authorization_servers`, and it accepts ES256
 * proofs. Checked before any token for the runner is asked for.
 */
export function runnerIdentityMismatch(
  runnerUrl: string,
  identity: ProtectedResourceMetadata | undefined,
  issuer: string,
): string | undefined {
  if (identity === undefined || identity === null || typeof identity !== "object" || typeof identity.resource !== "string") {
    return `${runnerUrl} advertises no identity`;
  }
  if (!sameResource(identity.resource, runnerUrl)) {
    return `${runnerUrl} identifies as ${identity.resource}; a sign-in is sent only to the runner it names`;
  }
  const servers = Array.isArray(identity.authorization_servers)
    ? identity.authorization_servers.filter((server): server is string => typeof server === "string")
    : [];
  if (!servers.some((server) => sameResource(server, issuer))) {
    return `${runnerUrl} accepts sign-ins from ${servers.length > 0 ? servers.join(", ") : "no issuer"}, not ${issuer} (${ACCOUNTS_URL_ENV})`;
  }
  const algorithms = Array.isArray(identity.dpop_signing_alg_values_supported) ? identity.dpop_signing_alg_values_supported : [];
  if (!algorithms.includes(DPOP_ALGORITHM)) {
    return `${runnerUrl} accepts no DPoP key telo signs with (${DPOP_ALGORITHM})`;
  }
  return undefined;
}

/** RFC 9728 §3.1: the metadata URL, the well-known segment inserted before a path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const pathname = withoutTrailingSlashes(url.pathname);
  return `${url.protocol}//${url.host}/.well-known/oauth-protected-resource${pathname}`;
}

/** A runner's RFC 9728 metadata, `undefined` when it publishes none (404). */
export async function readProtectedResourceMetadata(
  runnerUrl: string,
  options: { fetch: typeof fetch; signal: AbortSignal; timeoutMs: number },
): Promise<ProtectedResourceMetadata | undefined> {
  const url = protectedResourceMetadataUrl(runnerUrl);
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch (error) {
    options.signal.throwIfAborted();
    throw new SignInError(undefined, `could not reach ${url}: ${failureCause(error)}`);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) throw new SignInError(undefined, `${url} answered ${response.status} ${response.statusText}`.trimEnd());
  try {
    return (await response.json()) as ProtectedResourceMetadata;
  } catch (error) {
    options.signal.throwIfAborted();
    throw new SignInError(undefined, `${url} answered no JSON document: ${failureCause(error)}`);
  }
}
