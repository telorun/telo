export interface CloudIdentity {
  user: { id: string; name: string | null; email: string | null };
  org: { id: string };
  permissions: string[];
  expiresAt: string;
  /** The Telo Cloud console's address, as Cloud names it; null when it names
   *  none. Studio links there for what only the console does and takes the
   *  address from nowhere else. */
  consoleUrl: string | null;
}

/**
 * Whether Studio has a Telo Cloud user.
 *
 * - `unavailable` — this origin has no Cloud behind it (the dev server, a
 *   self-hosted static copy): every Cloud control is hidden.
 * - `unreachable` — Cloud exists but could not be asked; a grant, if there is
 *   one, is kept.
 */
export type CloudSessionState =
  | { status: "unavailable" }
  | { status: "unreachable"; message: string }
  | { status: "anonymous" }
  | { status: "signedIn"; identity: CloudIdentity };

/** Sign-in as each build does it. A web sign-in, sign-out and organization
 *  switch are full-page navigations, so those promises never settle there. */
export interface CloudSessionSource {
  read(): Promise<CloudSessionState>;
  /** `orgId` names the organization to sign in to; only the web build, which
   *  is the only one a link reaches, is ever given one. */
  signIn(orgId?: string): Promise<CloudSessionState>;
  switchOrganization(): Promise<CloudSessionState>;
  signOut(): Promise<void>;
}

export function isCloudIdentity(value: unknown): value is CloudIdentity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const user = v.user as Record<string, unknown> | undefined;
  const org = v.org as Record<string, unknown> | undefined;
  return (
    typeof user === "object" &&
    user !== null &&
    typeof user.id === "string" &&
    typeof org === "object" &&
    org !== null &&
    typeof org.id === "string" &&
    Array.isArray(v.permissions) &&
    typeof v.expiresAt === "string"
  );
}

/** The identity of a session answer that {@link isCloudIdentity} accepted. */
export function identityOf(value: CloudIdentity): CloudIdentity {
  const { user, org, permissions, expiresAt } = value;
  const consoleUrl = (value as { consoleUrl?: unknown }).consoleUrl;
  return {
    user,
    org,
    permissions,
    expiresAt,
    consoleUrl: typeof consoleUrl === "string" && consoleUrl !== "" ? consoleUrl : null,
  };
}

/** Whether the session is signed in with `permission`. */
export function hasPermission(
  state: CloudSessionState | { status: "loading" },
  permission: string,
): boolean {
  return state.status === "signedIn" && state.identity.permissions.includes(permission);
}

export function displayName(identity: CloudIdentity): string {
  return identity.user.name ?? identity.user.email ?? identity.user.id;
}
