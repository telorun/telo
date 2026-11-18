import type { RunnerCredentialAnswer, RunnerCredentialRequest } from "@telorun/share-tunnel";

import { userAppDirectory } from "../desktop/desktop-app-directory.js";
import { LockFileBusy, takeLockFile, type LockHold } from "../lock-file.js";
import { openBrowser } from "../open-browser.js";
import {
  deviceCodeSignIn,
  LOOPBACK_WAIT_MS,
  loopbackSignIn,
  type BrowserOpener,
  type GrantRequest,
  type GrantTokens,
  type SignInEvent,
} from "./authorization-flows.js";
import { CredentialsFile, type CredentialsDocument, type SignInAccount, type SignInRecord, type SignInResources, type StoredAccessToken } from "./credentials-file.js";
import { DpopKey } from "./dpop-key.js";
import { readIssuerEndpoints, type IssuerEndpoints } from "./issuer-metadata.js";
import { failureCause } from "./request-failure.js";
import { normalizeResourceUrl, readProtectedResourceMetadata, runnerIdentityMismatch, sameResource } from "./runner-identity.js";
import { CLI_CLIENT_ID, CLI_SCOPES, resolveAccountsIssuer, resolveCloudApiUrl } from "./sign-in-config.js";
import { SignInError } from "./sign-in-error.js";
import { refusalText, TOKEN_REQUEST_TIMEOUT_MS, TokenEndpoint, type TokenAnswer } from "./token-endpoint.js";

/** A lock untouched this long is a crashed process's, and is taken over. */
const LOCK_STALE_MS = 60_000;
/** How long a credential request waits for another process's refresh or login. */
const LOCK_WAIT_MS = 30_000;
/** A refresh whose answer was lost is presented again only while it still
 *  reaches accounts inside its 30 s window for identical retries. */
const REPRESENT_WITHIN_MS = 28_000;
const MIN_REPRESENT_BUDGET_MS = 2_000;

/** The CLI's answer: the port's, a sign-in-required one also saying why when the
 *  reason is more than "no sign-in" (a sign-in covering another runner). */
export type SignInCredentialAnswer =
  | Exclude<RunnerCredentialAnswer, { outcome: "sign-in-required" }>
  | (Extract<RunnerCredentialAnswer, { outcome: "sign-in-required" }> & { message?: string });

export interface SignInCredentialProvider {
  credential(request: RunnerCredentialRequest): Promise<SignInCredentialAnswer>;
}

/** What `telo auth status` and `telo auth login` answer. */
export interface SignInStatus {
  ok: boolean;
  signedIn: boolean;
  issuer: string;
  account: SignInAccount | null;
  resources: SignInResources | null;
  /** Whether accounts confirmed the sign-in just now. */
  verified: boolean;
  problem?: { code: string | null; message: string };
}

export type LogoutResult =
  | { outcome: "not-signed-in"; issuer: string }
  | { outcome: "signed-out"; issuer: string; account: SignInAccount }
  /** Forgotten on this machine; the grant at accounts is still live. */
  | { outcome: "revoke-failed"; issuer: string; account: SignInAccount; error: SignInError };

export interface LoginOptions {
  /** The runner the grant names beside the Cloud API, resolved by the caller. */
  runnerUrl: string;
  /** `--device-code`: never the browser. */
  deviceCode?: boolean;
  signal: AbortSignal;
  /** Called with the URL to open, or the code to enter, and when the browser cannot be opened. */
  onEvent: (event: SignInEvent) => void;
}

export interface RunnerSignInOptions {
  /** Where `TELO_ACCOUNTS_URL`, `TELO_CLOUD_API_URL`, the display and the state directory are read from. */
  env: NodeJS.ProcessEnv;
  /** The command a person runs to sign in for `runnerUrl`. */
  signInCommand: (runnerUrl: string) => string;
  /** `credentials.json`'s directory; telo's per-user state directory when absent. */
  directory?: string;
  fetch?: typeof fetch;
  openBrowser?: BrowserOpener;
  platform?: NodeJS.Platform;
  /** How long a browser sign-in waits for the redirect back. */
  loopbackWaitMs?: number;
}

/** What one look at the store and, if need be, accounts gave. */
type Obtained =
  | { kind: "token"; record: SignInRecord; token: StoredAccessToken }
  | { kind: "signed-out" }
  | { kind: "not-covered"; resource: string }
  /** Accounts answered `invalid_grant`; the record is deleted. */
  | { kind: "revoked"; reason: string }
  /** Accounts refused the refresh for good (`invalid_dpop_proof`, `invalid_target`); the record is kept. */
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; message: string };

/** What a joined caller shares: one refresh per audience, its lock wait ended
 *  only when every caller waiting on it has given up. */
interface Flight {
  promise: Promise<Obtained>;
  waiters: number;
  lockWait: AbortController;
}

/** A signal nothing aborts: a refresh holding the lock runs to its own deadlines,
 *  since a rotated refresh token that is not written is lost for good. */
const UNCANCELLED = new AbortController().signal;

/**
 * The CLI's sign-in to Telo accounts: one grant naming the Cloud API and a
 * runner, its DPoP key, and the runner tokens refreshed from it. The file is the
 * only source of truth: every call reads `credentials.json` again, and every
 * refresh or change happens under `credentials.json.lock`.
 */
export class RunnerSignIn implements SignInCredentialProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly flights = new Map<string, Flight>();
  private endpointsRead: { issuer: string; read: Promise<IssuerEndpoints> } | undefined;
  private tokenEndpoint: TokenEndpoint | undefined;

  constructor(private readonly options: RunnerSignInOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The accounts issuer, read from the environment at each call, so a value an
   *  `.env` file supplies after construction applies. */
  get issuer(): string {
    return resolveAccountsIssuer(this.options.env);
  }

  /** The grant's Cloud API resource, read as {@link issuer} is. */
  get cloudResource(): string {
    return resolveCloudApiUrl(this.options.env);
  }

  /** A runner token and its proofs, refreshed under the lock when the stored one
   *  does not outlive `minLifetimeMs`. Rejects only with the signal's reason. A
   *  caller that gives up stops waiting; a refresh under way still completes and
   *  is written, for the callers that remain and the next one. */
  async credential(request: RunnerCredentialRequest): Promise<SignInCredentialAnswer> {
    const key = normalizeResourceUrl(request.runnerUrl);
    for (;;) {
      let flight = this.flights.get(key);
      const own = flight === undefined;
      if (flight === undefined) {
        const lockWait = new AbortController();
        const started: Flight = { promise: this.obtain(request.runnerUrl, request.minLifetimeMs, lockWait.signal, false), waiters: 0, lockWait };
        flight = started;
        this.flights.set(key, started);
        const landed = (): void => {
          if (this.flights.get(key) === started) this.flights.delete(key);
        };
        started.promise.then(landed, landed);
      }
      flight.waiters++;
      let obtained: Obtained;
      try {
        obtained = await untilAborted(flight.promise, request.signal);
      } catch (error) {
        if (request.signal.aborted && --flight.waiters === 0) {
          // Nobody waits for the lock any more; a refresh already holding it is not touched.
          if (this.flights.get(key) === flight) this.flights.delete(key);
          flight.lockWait.abort(request.signal.reason);
        }
        throw error;
      }
      if (!own && obtained.kind === "token" && Date.parse(obtained.token.expiresAt) - Date.now() <= request.minLifetimeMs) continue;
      return this.answer(request.runnerUrl, obtained);
    }
  }

  /** Whether `credentials.json` holds a sign-in for the issuer; nothing is asked of accounts. */
  async hasSignIn(): Promise<boolean> {
    return (await this.readOrRefuse(this.file())).signIns[this.issuer] !== undefined;
  }

  /**
   * Signs this machine in: checks the runner's RFC 9728 identity, authorizes one
   * grant naming the Cloud API and the runner, bound to a fresh ES256 key, and
   * writes it to `credentials.json` in place of any earlier one for the issuer.
   * The browser flow, or a device code when no browser can reach the person.
   * Throws a {@link SignInError}, or the signal's reason.
   */
  async login(options: LoginOptions): Promise<SignInStatus> {
    const { signal } = options;
    const issuer = this.issuer;
    const cloudResource = this.cloudResource;
    const runner = normalizeResourceUrl(options.runnerUrl);
    const file = this.file();
    // A store that cannot be read is refused before a grant is created that could not be kept.
    await this.readOrRefuse(file);
    const identity = await readProtectedResourceMetadata(runner, { fetch: this.fetchImpl, signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS });
    const mismatch = runnerIdentityMismatch(runner, identity, issuer);
    if (mismatch !== undefined || identity === undefined) throw new SignInError("ERR_RUNNER_IDENTITY_MISMATCH", mismatch ?? `${runner} advertises no identity`);
    const endpoints = await this.endpoints(signal).catch((error: unknown) => {
      signal.throwIfAborted();
      throw new SignInError(undefined, failureCause(error));
    });
    const tokens = this.tokens(endpoints);
    // The runner's own spelling of itself is what the grant names and covers.
    const resources: SignInResources = { cloud: cloudResource, runner: identity.resource };
    const request: GrantRequest = {
      endpoints,
      clientId: CLI_CLIENT_ID,
      scopes: CLI_SCOPES,
      resources: [resources.cloud, resources.runner],
      tokenResource: resources.runner,
      key: DpopKey.generate(),
    };

    let granted: GrantTokens | "browser-failed" = "browser-failed";
    if (!options.deviceCode && !prefersDeviceCode(this.options.env, this.options.platform ?? process.platform)) {
      granted = await loopbackSignIn(request, tokens, {
        signal,
        onEvent: options.onEvent,
        openBrowser: this.options.openBrowser ?? ((url, onFailure) => openBrowser(url, { env: this.options.env, onFailure })),
        waitMs: this.options.loopbackWaitMs ?? LOOPBACK_WAIT_MS,
      });
    }
    if (granted === "browser-failed") {
      granted = await deviceCodeSignIn(request, tokens, { signal, onEvent: options.onEvent, fetch: this.fetchImpl });
    }

    const { body, sentAt, nonce } = granted;
    if (body.token_type.toLowerCase() !== "dpop") {
      throw new SignInError("ERR_SIGN_IN_FAILED", `${this.issuer} issued a ${body.token_type} token, not one bound to telo's key`);
    }
    if (typeof body.refresh_token !== "string") {
      throw new SignInError("ERR_SIGN_IN_FAILED", `${this.issuer} granted no refresh token (offline_access)`);
    }
    const account = accountFromIdToken(body.id_token, issuer, CLI_CLIENT_ID, nonce);
    const record: SignInRecord = {
      clientId: CLI_CLIENT_ID,
      dpopKey: request.key.jwk,
      refreshToken: body.refresh_token,
      resources,
      account,
      accessTokens: { [resources.runner]: { token: body.access_token, expiresAt: new Date(sentAt + body.expires_in * 1000).toISOString() } },
      signedInAt: new Date().toISOString(),
    };
    // The record in the file when the new one is written — the latest rotated
    // token, whichever process rotated it — is the one the new sign-in replaces.
    let replaced: SignInRecord | undefined;
    try {
      replaced = await this.underLock(file, signal, async (lock) => {
        const document = await this.readOrRefuse(file);
        await file.write({ ...document, signIns: { ...document.signIns, [issuer]: record } }, lock);
        return document.signIns[issuer];
      });
    } catch (error) {
      // The grant exists at accounts and nothing here holds it: revoke it, outside the lock.
      const failure = await this.revoke(record, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS));
      if (signal.aborted || !(error instanceof SignInError)) throw error;
      const outcome =
        failure === undefined
          ? `the new sign-in at ${issuer} was revoked again`
          : `the new sign-in at ${issuer} could not be revoked (${failure}); it stays valid until revoked under Apps and devices at ${issuer}`;
      throw new SignInError("ERR_SIGN_IN_FAILED", `${error.message}; ${outcome}`, error.hints);
    }
    const status: SignInStatus = { ok: true, signedIn: true, issuer, account, resources, verified: true };
    if (replaced === undefined) return status;
    const failure = await this.revoke(replaced, signal);
    if (failure === undefined) return status;
    return {
      ...status,
      problem: {
        code: "ERR_SIGN_IN_REVOKE_FAILED",
        message: `signed in, but the earlier sign-in at ${issuer} could not be revoked (${failure}); it stays valid until revoked under Apps and devices at ${issuer}`,
      },
    };
  }

  /**
   * Revokes the refresh token at accounts (RFC 7009), then forgets the sign-in
   * whatever accounts answered. Throws a {@link SignInError} when the store
   * cannot be read or locked, or the signal's reason (after forgetting).
   */
  async logout(options: { signal: AbortSignal }): Promise<LogoutResult> {
    const { signal } = options;
    const file = this.file();
    return this.underLock(file, signal, async (lock) => {
      const document = await this.readOrRefuse(file);
      const record = document.signIns[this.issuer];
      if (record === undefined) return { outcome: "not-signed-in", issuer: this.issuer };
      const failure = await this.revoke(record, signal);
      const { [this.issuer]: forgotten, ...rest } = document.signIns;
      await file.write({ ...document, signIns: rest }, lock);
      if (failure === undefined) return { outcome: "signed-out", issuer: this.issuer, account: forgotten!.account };
      return {
        outcome: "revoke-failed",
        issuer: this.issuer,
        account: forgotten!.account,
        error: new SignInError(
          "ERR_SIGN_IN_REVOKE_FAILED",
          `signed out on this machine, but the sign-in at ${this.issuer} could not be revoked (${failure}); it stays valid until revoked under Apps and devices at ${this.issuer}`,
        ),
      };
    });
  }

  /** The stored sign-in, confirmed by refreshing the runner audience under the
   *  lock; `invalid_grant` deletes it and reports signed out. */
  async status(options: { signal: AbortSignal }): Promise<SignInStatus> {
    const signedOut = (problem?: SignInStatus["problem"]): SignInStatus => ({
      ok: false,
      signedIn: false,
      issuer: this.issuer,
      account: null,
      resources: null,
      verified: false,
      ...(problem ? { problem } : {}),
    });
    let record: SignInRecord | undefined;
    try {
      record = (await this.file().read()).signIns[this.issuer];
    } catch (error) {
      return signedOut({ code: null, message: (error as Error).message });
    }
    if (record === undefined) return signedOut();
    let obtained: Obtained;
    try {
      obtained = await untilAborted(this.obtain(record.resources.runner, Number.POSITIVE_INFINITY, options.signal, true), options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      throw error;
    }
    if (obtained.kind === "token") {
      const { account, resources } = obtained.record;
      return { ok: true, signedIn: true, issuer: this.issuer, account, resources, verified: true };
    }
    if (obtained.kind === "signed-out") return signedOut();
    if (obtained.kind === "revoked" || obtained.kind === "refused") return signedOut({ code: "ERR_RUNNER_SIGN_IN_REQUIRED", message: obtained.reason });
    if (obtained.kind === "not-covered") {
      return signedOut({ code: "ERR_RUNNER_SIGN_IN_REQUIRED", message: `the sign-in at ${this.issuer} was replaced while it was confirmed` });
    }
    return {
      ok: false,
      signedIn: true,
      issuer: this.issuer,
      account: record.account,
      resources: record.resources,
      verified: false,
      problem: { code: null, message: obtained.message },
    };
  }

  private answer(runnerUrl: string, obtained: Obtained): SignInCredentialAnswer {
    const signInRequired = (message?: string): SignInCredentialAnswer => ({
      outcome: "sign-in-required",
      runnerUrl,
      command: this.options.signInCommand(runnerUrl),
      ...(message === undefined ? {} : { message }),
    });
    switch (obtained.kind) {
      case "signed-out":
        return signInRequired();
      case "not-covered":
        return signInRequired(`the sign-in at ${this.issuer} covers ${obtained.resource}, not ${runnerUrl}`);
      case "revoked":
      case "refused":
        return signInRequired(obtained.reason);
      case "unavailable":
        return { outcome: "unavailable", message: obtained.message };
      case "token": {
        let key: DpopKey;
        try {
          key = DpopKey.fromJwk(obtained.record.dpopKey);
        } catch (error) {
          return { outcome: "unavailable", message: `the sign-in's DPoP key in ${this.file().file} is unusable: ${(error as Error).message}` };
        }
        const accessToken = obtained.token.token;
        return {
          outcome: "credential",
          credential: {
            accessToken,
            expiresAt: new Date(obtained.token.expiresAt),
            proof: async ({ htm, htu, nonce }) => key.proof({ htm, htu, accessToken, ...(nonce === undefined ? {} : { nonce }) }),
          },
        };
      }
    }
  }

  /**
   * The runner token for `runnerUrl`: the stored one when it outlives
   * `minLifetimeMs` (no lock), else under the lock, a token another process just
   * wrote or a refresh written before the lock is released. `force` refreshes
   * whatever is stored. `lockWait` ends only the wait for the lock: once it is
   * held the refresh and its write are bound by the request deadlines alone.
   * Rejects only with `lockWait`'s reason.
   */
  private async obtain(runnerUrl: string, minLifetimeMs: number, lockWait: AbortSignal, force: boolean): Promise<Obtained> {
    let waitAborted = false;
    try {
      const file = this.file();
      const first = this.covering(await file.read(), runnerUrl, minLifetimeMs, force);
      if (first.kind !== "refresh") return first;
      let lock: LockHold;
      try {
        lock = await takeLockFile(file.lock, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, signal: lockWait });
      } catch (error) {
        if (lockWait.aborted) {
          waitAborted = true;
          throw lockWait.reason;
        }
        if (error instanceof LockFileBusy) {
          return { kind: "unavailable", message: `another telo process holds the sign-in lock ${file.lock} and did not release it within ${LOCK_WAIT_MS / 1000} s` };
        }
        throw error;
      }
      try {
        const document = await file.read();
        const settled = this.covering(document, runnerUrl, minLifetimeMs, force);
        if (settled.kind !== "refresh") return settled;
        return await this.refresh(file, document, settled.record, lock);
      } finally {
        await lock.release();
      }
    } catch (error) {
      if (waitAborted) throw error;
      return { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What the stored document says for `runnerUrl` before asking accounts. */
  private covering(
    document: CredentialsDocument,
    runnerUrl: string,
    minLifetimeMs: number,
    force: boolean,
  ): Obtained | { kind: "refresh"; record: SignInRecord } {
    const record = document.signIns[this.issuer];
    if (record === undefined) return { kind: "signed-out" };
    const resource = record.resources.runner;
    if (!sameResource(resource, runnerUrl)) return { kind: "not-covered", resource };
    const token = record.accessTokens[resource];
    if (!force && token !== undefined && Date.parse(token.expiresAt) - Date.now() > minLifetimeMs) {
      return { kind: "token", record, token };
    }
    return { kind: "refresh", record };
  }

  /** Refreshes the runner audience and writes the rotated refresh token with the
   *  new access token, under the lock the caller holds. */
  private async refresh(file: CredentialsFile, document: CredentialsDocument, record: SignInRecord, lock: LockHold): Promise<Obtained> {
    const resource = record.resources.runner;
    const endpoints = await this.endpoints(UNCANCELLED);
    const tokens = this.tokens(endpoints);
    const key = DpopKey.fromJwk(record.dpopKey);
    const form = { grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: record.clientId, resource };
    const firstSent = Date.now();
    let answer: TokenAnswer = await tokens.request(form, key, { signal: UNCANCELLED, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS });
    if (answer.kind === "unreachable" && answer.mayBeLost) {
      // Settled inside this attempt: the next attempt would fall outside accounts'
      // window for identical retries, and a rotated token presented then revokes the grant.
      const budget = firstSent + REPRESENT_WITHIN_MS - Date.now();
      if (budget >= MIN_REPRESENT_BUDGET_MS) {
        answer = await tokens.request(form, key, { signal: UNCANCELLED, timeoutMs: Math.min(TOKEN_REQUEST_TIMEOUT_MS, budget) });
      }
    }
    if (answer.kind === "unreachable") {
      return { kind: "unavailable", message: `could not reach ${this.issuer} (${endpoints.tokenEndpoint}): ${answer.cause}` };
    }
    if (answer.kind === "refused") {
      if (answer.error === "invalid_grant") {
        const { [this.issuer]: revoked, ...rest } = document.signIns;
        await file.write({ ...document, signIns: rest }, lock);
        return { kind: "revoked", reason: `the sign-in at ${this.issuer} is no longer valid (${refusalText(answer)})` };
      }
      const reason = `${this.issuer} refused to refresh the sign-in: ${refusalText(answer)}`;
      // The grant is intact, the request is what it refused: the record stays.
      if (answer.error === "invalid_dpop_proof" || answer.error === "invalid_target") return { kind: "refused", reason };
      return { kind: "unavailable", message: reason };
    }
    const { body, sentAt } = answer;
    if (body.token_type.toLowerCase() !== "dpop") {
      return { kind: "unavailable", message: `${this.issuer} issued a ${body.token_type} token, not one bound to the sign-in's key` };
    }
    const token: StoredAccessToken = { token: body.access_token, expiresAt: new Date(sentAt + body.expires_in * 1000).toISOString() };
    const refreshed: SignInRecord = {
      ...record,
      refreshToken: body.refresh_token ?? record.refreshToken,
      accessTokens: { ...record.accessTokens, [resource]: token },
    };
    await file.write({ ...document, signIns: { ...document.signIns, [this.issuer]: refreshed } }, lock);
    return { kind: "token", record: refreshed, token };
  }

  /** Revokes the record's refresh token; the reason it could not, else `undefined`. */
  private async revoke(record: SignInRecord, signal: AbortSignal): Promise<string | undefined> {
    try {
      const endpoints = await this.endpoints(signal);
      const response = await this.fetchImpl(endpoints.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: record.refreshToken, token_type_hint: "refresh_token", client_id: record.clientId }).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
      });
      if (response.ok) return undefined;
      const text = await response.text().catch(() => "");
      let error: string | undefined;
      try {
        const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
        if (typeof body.error === "string") error = typeof body.error_description === "string" ? `${body.error}: ${body.error_description}` : body.error;
      } catch {
        error = undefined;
      }
      return `${endpoints.revocationEndpoint} answered ${response.status}${error ? ` ${error}` : ""}`;
    } catch (error) {
      if (signal.aborted) return "cancelled before accounts answered";
      return failureCause(error);
    }
  }

  private async underLock<T>(file: CredentialsFile, signal: AbortSignal, work: (lock: LockHold) => Promise<T>): Promise<T> {
    let lock: LockHold;
    try {
      await file.ensureDirectory();
      lock = await takeLockFile(file.lock, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, signal });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof LockFileBusy) {
        throw new SignInError(undefined, `another telo process holds the sign-in lock ${file.lock} and did not release it within ${LOCK_WAIT_MS / 1000} s`);
      }
      throw new SignInError(undefined, (error as Error).message);
    }
    try {
      return await work(lock);
    } catch (error) {
      if (error instanceof SignInError || signal.aborted) throw error;
      throw new SignInError(undefined, error instanceof Error ? error.message : String(error));
    } finally {
      await lock.release();
    }
  }

  private async readOrRefuse(file: CredentialsFile): Promise<CredentialsDocument> {
    try {
      return await file.read();
    } catch (error) {
      throw new SignInError(undefined, (error as Error).message);
    }
  }

  private file(): CredentialsFile {
    const directory = this.options.directory ?? userAppDirectory("telo", { env: this.options.env, platform: this.options.platform });
    if (directory === null) {
      throw new SignInError(undefined, "this machine has no per-user state directory to keep the sign-in in (HOME, or LOCALAPPDATA on Windows, is unset)");
    }
    return new CredentialsFile(directory);
  }

  /** The issuer's endpoints, read once per process and issuer; a failed read is
   *  asked again next time. Shared by concurrent calls, so only a deadline bounds the read. */
  private endpoints(signal: AbortSignal): Promise<IssuerEndpoints> {
    const issuer = this.issuer;
    if (this.endpointsRead?.issuer !== issuer) {
      const read = readIssuerEndpoints(issuer, { fetch: this.fetchImpl, signal: new AbortController().signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS });
      const entry = { issuer, read };
      this.endpointsRead = entry;
      read.then(undefined, () => {
        if (this.endpointsRead === entry) this.endpointsRead = undefined;
      });
    }
    return untilAborted(this.endpointsRead.read, signal);
  }

  private tokens(endpoints: IssuerEndpoints): TokenEndpoint {
    if (this.tokenEndpoint?.url !== endpoints.tokenEndpoint) this.tokenEndpoint = new TokenEndpoint(endpoints.tokenEndpoint, this.fetchImpl);
    return this.tokenEndpoint;
  }
}

/**
 * Whether a browser on this machine cannot reach the person: over SSH a redirect
 * to `127.0.0.1` lands on the remote machine, and a Linux session with no display
 * and no `BROWSER` has nothing to open.
 */
export function prefersDeviceCode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.BROWSER;
}

/**
 * The account an ID token names. It arrived from the token endpoint over the
 * connection the CLI opened, so its signature is not checked (OIDC Core §3.1.3.7);
 * its issuer, audience and nonce are.
 */
export function accountFromIdToken(idToken: string | undefined, issuer: string, clientId: string, nonce: string | undefined): SignInAccount {
  if (typeof idToken !== "string") throw new SignInError("ERR_SIGN_IN_FAILED", `${issuer} answered no ID token`);
  let claims: Record<string, unknown>;
  try {
    const payload = idToken.split(".")[1];
    claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new SignInError("ERR_SIGN_IN_FAILED", `${issuer} answered an ID token that is not a JWT`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== "string" || !sameResource(claims.iss, issuer)) {
    throw new SignInError("ERR_SIGN_IN_FAILED", `the ID token was issued by ${String(claims.iss)}, not ${issuer}`);
  }
  if (!audiences.includes(clientId)) throw new SignInError("ERR_SIGN_IN_FAILED", `the ID token is not for ${clientId}`);
  if (nonce !== undefined && claims.nonce !== nonce) throw new SignInError("ERR_SIGN_IN_FAILED", "the ID token does not carry this sign-in's nonce");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new SignInError("ERR_SIGN_IN_FAILED", "the ID token names no subject");
  return { sub: claims.sub, username: typeof claims.preferred_username === "string" && claims.preferred_username !== "" ? claims.preferred_username : null };
}

/** `promise`, or the signal's reason once it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
