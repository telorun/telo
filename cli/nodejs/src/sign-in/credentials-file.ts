import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { writeFileAtomically } from "../atomic-file.js";
import type { LockHold } from "../lock-file.js";
import type { DpopPrivateJwk } from "./dpop-key.js";

/** The file, in telo's per-user state directory, holding every sign-in. */
export const CREDENTIALS_FILE = "credentials.json";
/** The format generation `credentials.json` is written in. */
export const CREDENTIALS_VERSION = 1;

/** Who signed in, from the ID token: its subject and `preferred_username`. */
export interface SignInAccount {
  sub: string;
  username: string | null;
}

/** The resources one grant names. */
export interface SignInResources {
  cloud: string;
  runner: string;
}

export interface StoredAccessToken {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** One sign-in, keyed in the file by its issuer URL. */
export interface SignInRecord {
  clientId: string;
  /** The private key every token of the grant is bound to. */
  dpopKey: DpopPrivateJwk;
  refreshToken: string;
  resources: SignInResources;
  account: SignInAccount;
  /** By resource URL. */
  accessTokens: Record<string, StoredAccessToken>;
  /** ISO 8601. */
  signedInAt: string;
}

export interface CredentialsDocument {
  version: typeof CREDENTIALS_VERSION;
  signIns: Record<string, SignInRecord>;
}

/** `credentials.json` and its lock, in one directory. */
export class CredentialsFile {
  readonly file: string;
  readonly lock: string;

  constructor(readonly directory: string) {
    this.file = path.join(directory, CREDENTIALS_FILE);
    this.lock = `${this.file}.lock`;
  }

  /** The document as the file holds it; an empty one when there is no file.
   *  Throws an `Error` naming the file when it cannot be read as one. */
  async read(): Promise<CredentialsDocument> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: CREDENTIALS_VERSION, signIns: {} };
      throw new Error(`cannot read ${this.file}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.file} is not valid JSON (${(error as Error).message}); fix or delete it`);
    }
    return parseDocument(parsed, this.file);
  }

  /** Writes the whole document, 0600, under the caller's lock on the file: a
   *  killed write leaves the old file or the new, and one made after the lock was
   *  taken over fails. The directory is 0700. */
  async write(document: CredentialsDocument, lock: LockHold): Promise<void> {
    await this.ensureDirectory();
    await writeFileAtomically(this.file, `${JSON.stringify(document, null, 2)}\n`, { lock, mode: 0o600 });
  }

  /** The directory, created 0700 and tightened to it on POSIX. */
  async ensureDirectory(): Promise<void> {
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(this.directory, 0o700);
  }
}

function parseDocument(value: unknown, file: string): CredentialsDocument {
  const refuse = (what: string): never => {
    throw new Error(`${file} ${what}; fix or delete it`);
  };
  if (!isObject(value)) return refuse("must hold an object");
  if (value.version !== CREDENTIALS_VERSION) {
    return refuse(
      typeof value.version === "number" && value.version > CREDENTIALS_VERSION
        ? `was written by a newer telo (version ${value.version}; this telo reads ${CREDENTIALS_VERSION})`
        : `has no version this telo reads (${CREDENTIALS_VERSION})`,
    );
  }
  if (!isObject(value.signIns)) return refuse("has no signIns object");
  const signIns: Record<string, SignInRecord> = {};
  for (const [issuer, record] of Object.entries(value.signIns)) {
    const problem = recordProblem(record);
    if (problem !== undefined) return refuse(`holds a sign-in for ${issuer} that ${problem}`);
    signIns[issuer] = record as SignInRecord;
  }
  return { version: CREDENTIALS_VERSION, signIns };
}

function recordProblem(record: unknown): string | undefined {
  if (!isObject(record)) return "is not an object";
  for (const key of ["clientId", "refreshToken", "signedInAt"] as const) {
    if (typeof record[key] !== "string") return `has no ${key}`;
  }
  const key = record.dpopKey;
  if (!isObject(key) || key.kty !== "EC" || key.crv !== "P-256" || !["x", "y", "d"].every((part) => typeof key[part] === "string")) {
    return "has no ES256 dpopKey";
  }
  const resources = record.resources;
  if (!isObject(resources) || typeof resources.cloud !== "string" || typeof resources.runner !== "string") return "has no resources";
  const account = record.account;
  if (!isObject(account) || typeof account.sub !== "string") return "has no account";
  if (account.username !== null && typeof account.username !== "string") return "has an account username that is not a string";
  if (!isObject(record.accessTokens)) return "has no accessTokens";
  for (const [resource, token] of Object.entries(record.accessTokens)) {
    if (!isObject(token) || typeof token.token !== "string" || typeof token.expiresAt !== "string" || Number.isNaN(Date.parse(token.expiresAt))) {
      return `has a malformed access token for ${resource}`;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
