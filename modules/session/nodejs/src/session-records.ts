/** What the store holds for a session (`<name>/s/<id>`) and for a subject's
 *  index of sessions (`<name>/u/<sha256(subject)>`). Plain JSON throughout. */

export interface StoredPrincipal {
  subject: string;
  issuer: string | null;
  kind: "user" | "service";
  claims: Record<string, unknown>;
  scopes: string[];
  roles: string[];
  permissions: string[];
  org: string | null;
}

export interface SessionRecord {
  /** SHA-256 of the token's validator, base64url. */
  digest: string;
  principal: StoredPrincipal;
  amr: string[];
  acr: string | null;
  /** Epoch milliseconds throughout. */
  authenticatedAt: number;
  createdAt: number;
  userAgent: string | null;
  address: string | null;
  persistent: boolean;
  /** The idle timeout this session was started under. */
  idleMs: number;
  lastSeenAt: number;
  /** The absolute deadline: the session ends then however busy it is. */
  expiresAt: number;
}

export interface IndexEntry {
  id: string;
  /** The session's absolute deadline. */
  expiresAt: number;
}

export interface IndexRecord {
  entries: IndexEntry[];
}

export const sessionKey = (name: string, id: string): string => `${name}/s/${id}`;
export const indexKey = (name: string, subjectDigest: string): string => `${name}/u/${subjectDigest}`;
