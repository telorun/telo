import { failureCause } from "./request-failure.js";
import { sameResource } from "./runner-identity.js";

/** The endpoints a sign-in uses, from the issuer's RFC 8414 metadata. */
export interface IssuerEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  revocationEndpoint: string;
}

/** RFC 8414 §3: the metadata URL, the well-known segment inserted before an issuer's path. */
export function issuerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}/.well-known/oauth-authorization-server${pathname}`;
}

/** Reads the issuer's metadata; throws an `Error` naming the issuer and what is wrong. */
export async function readIssuerEndpoints(
  issuer: string,
  options: { fetch: typeof fetch; signal: AbortSignal; timeoutMs: number },
): Promise<IssuerEndpoints> {
  const url = issuerMetadataUrl(issuer);
  let document: Record<string, unknown>;
  try {
    const response = await options.fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`.trimEnd());
    document = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    options.signal.throwIfAborted();
    throw new Error(`could not read ${issuer}'s metadata: ${failureCause(error)}`);
  }
  if (typeof document.issuer !== "string" || !sameResource(document.issuer, issuer)) {
    throw new Error(`${url} names the issuer ${String(document.issuer)}, not ${issuer}`);
  }
  const endpoint = (name: string): string => {
    const value = document[name];
    if (typeof value !== "string" || !URL.canParse(value)) throw new Error(`${issuer}'s metadata has no ${name}`);
    return value;
  };
  return {
    issuer,
    authorizationEndpoint: endpoint("authorization_endpoint"),
    tokenEndpoint: endpoint("token_endpoint"),
    deviceAuthorizationEndpoint: endpoint("device_authorization_endpoint"),
    revocationEndpoint: endpoint("revocation_endpoint"),
  };
}
