import type { PortProtocol, SessionConfig } from "../contract.js";

/**
 * The durable session record and the seam it is kept behind. A record holds no
 * secret: never session env, workload tokens or an agent's operator env — those
 * are supplied again for every run or pod. A resume secret is held only as its
 * SHA-256.
 */

/** Who owns a session: an identity `(iss, sub)`, or the SHA-256 (lowercase hex)
 *  of the resume secret it was created with. */
export type SessionOwner =
  | { kind: "identity"; iss: string; sub: string }
  | { kind: "secret"; secretHash: string };

export const STORED_SESSION_STATUSES = [
  "starting",
  "running",
  "suspended",
  "stopped",
  "failed",
] as const;

export type StoredSessionStatus = (typeof STORED_SESSION_STATUSES)[number];

export interface StoredSessionPort {
  port: number;
  protocol: PortProtocol;
}

/** One application of the session's app set. */
export interface StoredSessionApp {
  name: string;
  entryRelativePath: string;
  ports: StoredSessionPort[];
  /** The telo release the app runs on; absent when the runner chooses. */
  telo?: string;
}

export interface SessionRecord {
  id: string;
  owner: SessionOwner;
  /** The client's opaque name for the workspace. One session per owner and
   *  workspace. */
  workspace: string;
  /** Catalog name of the co-resident agent, or null for none. */
  agent: string | null;
  apps: StoredSessionApp[];
  config: SessionConfig;
  status: StoredSessionStatus;
  createdAt: Date;
  lastActiveAt: Date;
  suspendedAt: Date | null;
  /** The containers the session started through its engine, and how a run
   *  still live after a runner restart is admitted; null before the first. */
  containerEngine: StoredContainerEngine | null;
}

/** What a session's container engine needs back after a runner restart. */
export interface StoredContainerEngine {
  /** The SHA-256 (lowercase hex) of every engine token a live run may still
   *  hold — never a token. */
  tokenHashes: string[];
  containers: StoredSessionContainer[];
}

/** A container a session started, as core admitted it. */
export interface StoredSessionContainer {
  id: string;
  image: string;
  labels: Record<string, string>;
  ports: number[];
  /** The ports the create asked a binding for. */
  bound: number[];
}

export type CreateSessionResult =
  | { kind: "created"; record: SessionRecord }
  /** The owner already has a session for this workspace. */
  | { kind: "exists"; id: string };

export type ChangeOwnerResult =
  | { kind: "changed"; record: SessionRecord }
  /** The new owner already has a session for this session's workspace. */
  | { kind: "exists"; id: string }
  | { kind: "not_found" };

/** The fields of a record that change after creation. An absent field is left
 *  as it is. */
export interface SessionRecordUpdate {
  status?: StoredSessionStatus;
  lastActiveAt?: Date;
  suspendedAt?: Date | null;
  apps?: StoredSessionApp[];
  agent?: string | null;
  containerEngine?: StoredContainerEngine | null;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<CreateSessionResult>;
  get(id: string): Promise<SessionRecord | undefined>;
  listByOwner(owner: SessionOwner): Promise<SessionRecord[]>;
  /** Every record, for loading the registry at boot. */
  listAll(): Promise<SessionRecord[]>;
  /** Suspended records whose `suspendedAt` is earlier than `cutoff`. */
  listSuspendedBefore(cutoff: Date): Promise<SessionRecord[]>;
  /** The updated record, or undefined when no record has that id. */
  update(id: string, changes: SessionRecordUpdate): Promise<SessionRecord | undefined>;
  changeOwner(id: string, owner: SessionOwner): Promise<ChangeOwnerResult>;
  /** Whether a record was deleted. */
  delete(id: string): Promise<boolean>;
  /** Records a DPoP proof's `jti` until `expiresAt`. True when it was not
   *  already held unexpired at `now` — false is a replay. */
  recordJti(jti: string, expiresAt: Date, now: Date): Promise<boolean>;
  /** Removes every `jti` expired at `now`; returns how many. */
  purgeExpiredJtis(now: Date): Promise<number>;
  close(): Promise<void>;
}

/** The newest schema version this build reads and writes. */
export const SESSION_STORE_SCHEMA_VERSION = 2;

export class SessionStoreSchemaError extends Error {}

const SECRET_HASH = /^[0-9a-f]{64}$/;

/** The owner as the columns that store it, plus the key the one-session-per-
 *  owner-and-workspace constraint is declared over. */
export interface OwnerColumns {
  ownerKey: string;
  ownerIss: string | null;
  ownerSub: string | null;
  ownerSecretHash: string | null;
}

export function ownerColumns(owner: SessionOwner): OwnerColumns {
  if (owner.kind === "identity") {
    if (owner.iss === "" || owner.sub === "") {
      throw new TypeError("a session owner identity needs a non-empty `iss` and `sub`");
    }
    return {
      ownerKey: `identity:${JSON.stringify([owner.iss, owner.sub])}`,
      ownerIss: owner.iss,
      ownerSub: owner.sub,
      ownerSecretHash: null,
    };
  }
  if (!SECRET_HASH.test(owner.secretHash)) {
    throw new TypeError("a resume-secret owner is the secret's SHA-256 as 64 lowercase hex digits");
  }
  return {
    ownerKey: `secret:${owner.secretHash}`,
    ownerIss: null,
    ownerSub: null,
    ownerSecretHash: owner.secretHash,
  };
}

export function ownerFromColumns(
  iss: string | null,
  sub: string | null,
  secretHash: string | null,
): SessionOwner {
  if (secretHash !== null) return { kind: "secret", secretHash };
  if (iss !== null && sub !== null) return { kind: "identity", iss, sub };
  throw new SessionStoreSchemaError("a stored session has neither an identity nor a secret owner");
}

export function isStoredSessionStatus(value: string): value is StoredSessionStatus {
  return (STORED_SESSION_STATUSES as readonly string[]).includes(value);
}

export function storedStatus(value: string): StoredSessionStatus {
  if (!isStoredSessionStatus(value)) {
    throw new SessionStoreSchemaError(`a stored session has an unknown status '${value}'`);
  }
  return value;
}

/** Refuses a database a newer runner build has migrated past this one. */
export function assertReadableVersion(found: number, where: string): void {
  if (found > SESSION_STORE_SCHEMA_VERSION) {
    throw new SessionStoreSchemaError(
      `the session store at ${where} is at schema version ${found}, newer than the ` +
        `${SESSION_STORE_SCHEMA_VERSION} this runner reads — run the runner build that wrote it, or a newer one.`,
    );
  }
}
