/** The RFC 9728 fields a mount's `protectedResource:` writes. */
export interface ProtectedResourceSetting {
  readonly scopesSupported?: readonly string[];
  readonly resourceName?: string;
  readonly resourceDocumentation?: string;
  readonly resourcePolicyUri?: string;
  readonly resourceTosUri?: string;
}

/** What the mount's verifiers and sources publish, which the document is derived from. */
export interface ProtectedResourceReadings {
  readonly issuers: readonly string[];
  readonly bearerMethods: readonly string[];
}

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** Where a mount's metadata document is served: the well-known prefix, then the mount's path (RFC 9728 §3). */
export function metadataPath(mountPath: string): string {
  const path = mountPath.replace(/\/+$/, "");
  return path === "" ? WELL_KNOWN : `${WELL_KNOWN}${path.startsWith("/") ? path : `/${path}`}`;
}

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

/** The metadata document, under RFC 9728 names; an empty member is left out. */
export function protectedResourceDocument(
  resource: string,
  written: ProtectedResourceSetting,
  readings: ProtectedResourceReadings,
): Record<string, unknown> {
  const document: Record<string, unknown> = { resource };
  const members: Array<[string, unknown]> = [
    ["authorization_servers", distinct(readings.issuers)],
    ["bearer_methods_supported", distinct(readings.bearerMethods)],
    ["scopes_supported", written.scopesSupported ? distinct(written.scopesSupported) : undefined],
    ["resource_name", written.resourceName],
    ["resource_documentation", written.resourceDocumentation],
    ["resource_policy_uri", written.resourcePolicyUri],
    ["resource_tos_uri", written.resourceTosUri],
  ];
  for (const [name, value] of members) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    document[name] = value;
  }
  return document;
}
