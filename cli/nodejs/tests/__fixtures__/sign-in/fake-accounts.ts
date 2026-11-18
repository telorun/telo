import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** What a fake token endpoint answers: a body, or nothing at all (the answer is lost). */
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

interface Grant {
  id: number;
  jkt: string;
  resources: string[];
  refreshToken: string;
  /** Refresh tokens rotated away, with when and what their rotation answered. */
  rotated: Map<string, { at: number; answer: Answer }>;
  revoked: boolean;
}

interface Authorization {
  redirectUri: string;
  challenge: string;
  resources: string[];
  jkt: string;
  nonce: string | undefined;
}

interface DeviceCode {
  userCode: string;
  resources: string[];
  jkt: string;
  state: "pending" | "approved" | "denied" | "redeemed";
}

export interface FakeAccountsOptions {
  /** The person who approves, as the ID token names them: accounts puts only these two claims in telo-cli's. */
  account?: { sub: string; preferred_username?: string };
  /** Seconds between device code polls. */
  deviceInterval?: number;
}

/**
 * Telo accounts as the CLI sees it, on loopback: RFC 8414 metadata, an
 * authorization endpoint approving at once with a redirect to the loopback
 * callback, device codes, a token endpoint demanding DPoP proofs with nonces and
 * rotating refresh tokens with a 30 s window for identical retries (later reuse
 * revokes the grant), and revocation.
 */
export class FakeAccounts {
  readonly url: string;
  /** `expires_in` of every access token minted from now on. */
  accessTokenTtl = 600;
  /** Refresh answers to lose after rotating: the socket is closed instead. */
  dropRefreshAnswers = 0;
  /** Delays every refresh answer, so concurrent callers overlap. */
  refreshDelayMs = 0;
  /** How long a rotated-away refresh token is still answered from the window; later reuse revokes the grant. */
  reuseWindowMs = 30_000;
  /** An OAuth error every refresh is refused with, before anything rotates. */
  refreshError: string | undefined;
  /** The status `/oauth2/revoke` answers. */
  revokeStatus = 200;
  /** Rotations of a refresh token (a replay inside the window is not one). */
  refreshes = 0;
  /** Identical retries answered from the window. */
  replays = 0;
  /** `use_dpop_nonce` answers given. */
  nonceChallenges = 0;
  readonly authorizations: Array<Record<string, string | string[]>> = [];
  readonly deviceAuthorizations: Array<Record<string, string | string[]>> = [];
  readonly revocations: string[] = [];
  readonly grants: Grant[] = [];

  private nonce = "nonce-1";
  private serial = 0;
  private readonly codes = new Map<string, Authorization>();
  private readonly devices = new Map<string, DeviceCode>();

  private constructor(
    private readonly server: http.Server,
    port: number,
    private readonly options: FakeAccountsOptions,
  ) {
    this.url = `http://127.0.0.1:${port}`;
  }

  static async start(options: FakeAccountsOptions = {}): Promise<FakeAccounts> {
    let accounts: FakeAccounts | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => void accounts!.handle(req, res, Buffer.concat(chunks).toString()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    accounts = new FakeAccounts(server, (server.address() as AddressInfo).port, options);
    return accounts;
  }

  /** Hands out a new nonce: proofs carrying the old one are answered `use_dpop_nonce`. */
  rotateNonce(): void {
    this.nonce = `nonce-${++this.serial}`;
  }

  /** The person approves the device code shown to them. */
  approveDevice(userCode: string): void {
    for (const device of this.devices.values()) if (device.userCode === userCode) device.state = "approved";
  }

  /** Revokes a grant, as "Apps and devices" would. */
  revokeGrant(grant: Grant): void {
    grant.revoked = true;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, text: string): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/oauth2/authorize`,
        token_endpoint: `${this.url}/oauth2/token`,
        device_authorization_endpoint: `${this.url}/oauth2/device/code`,
        revocation_endpoint: `${this.url}/oauth2/revoke`,
        code_challenge_methods_supported: ["S256"],
        dpop_signing_alg_values_supported: ["ES256"],
      });
    }
    if (req.method === "GET" && url.pathname === "/oauth2/authorize") return this.authorize(url, res);
    const form = formOf(text);
    if (req.method === "POST" && url.pathname === "/oauth2/device/code") return this.deviceAuthorization(form, res);
    if (req.method === "POST" && url.pathname === "/oauth2/token") return this.token(req, res, form);
    if (req.method === "POST" && url.pathname === "/oauth2/revoke") {
      this.revocations.push(String(form.token));
      const grant = this.grants.find((one) => one.refreshToken === form.token || one.rotated.has(String(form.token)));
      if (this.revokeStatus === 200 && grant) grant.revoked = true;
      return json(res, this.revokeStatus, this.revokeStatus === 200 ? {} : { error: "temporarily_unavailable" });
    }
    json(res, 404, { error: "not_found" });
  }

  private authorize(url: URL, res: http.ServerResponse): void {
    const query: Record<string, string | string[]> = {};
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name);
      query[name] = name === "resource" ? values : values[0]!;
    }
    this.authorizations.push(query);
    const redirect = new URL(String(query.redirect_uri));
    const code = `code-${++this.serial}`;
    this.codes.set(code, {
      redirectUri: String(query.redirect_uri),
      challenge: String(query.code_challenge),
      resources: query.resource as string[],
      jkt: String(query.dpop_jkt),
      nonce: query.nonce as string | undefined,
    });
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", String(query.state));
    redirect.searchParams.set("iss", this.url);
    res.writeHead(302, { location: redirect.toString() });
    res.end();
  }

  private deviceAuthorization(form: Record<string, string | string[]>, res: http.ServerResponse): void {
    this.deviceAuthorizations.push(form);
    const deviceCode = `device-${++this.serial}`;
    const userCode = `ABCD-${this.serial}`;
    this.devices.set(deviceCode, { userCode, resources: asList(form.resource), jkt: String(form.dpop_jkt), state: "pending" });
    json(res, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${this.url}/device`,
      verification_uri_complete: `${this.url}/device?user_code=${userCode}`,
      expires_in: 600,
      interval: this.options.deviceInterval ?? 0.05,
    });
  }

  private async token(req: http.IncomingMessage, res: http.ServerResponse, form: Record<string, string | string[]>): Promise<void> {
    const proof = verifyProof(String(req.headers.dpop ?? ""), `${this.url}/oauth2/token`);
    res.setHeader("dpop-nonce", this.nonce);
    if (proof === undefined) return json(res, 400, { error: "invalid_dpop_proof" });
    if (proof.nonce !== this.nonce) {
      this.nonceChallenges++;
      return json(res, 400, { error: "use_dpop_nonce", error_description: "the DPoP proof must carry the nonce in DPoP-Nonce" });
    }
    const requested = asList(form.resource);
    if (requested.length > 1) return json(res, 400, { error: "invalid_target" });

    if (form.grant_type === "authorization_code") {
      const authorization = this.codes.get(String(form.code));
      this.codes.delete(String(form.code));
      if (!authorization || authorization.redirectUri !== form.redirect_uri) return json(res, 400, { error: "invalid_grant" });
      if (createHash("sha256").update(String(form.code_verifier)).digest("base64url") !== authorization.challenge) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      if (proof.jkt !== authorization.jkt) return json(res, 400, { error: "invalid_dpop_proof" });
      return this.mint(res, authorization.resources, requested, proof.jkt, authorization.nonce);
    }
    if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      const device = this.devices.get(String(form.device_code));
      if (!device || device.state === "redeemed") return json(res, 400, { error: "invalid_grant" });
      if (device.state === "pending") return json(res, 400, { error: "authorization_pending" });
      if (device.state === "denied") return json(res, 400, { error: "access_denied" });
      if (proof.jkt !== device.jkt) return json(res, 400, { error: "invalid_dpop_proof" });
      device.state = "redeemed";
      return this.mint(res, device.resources, requested, proof.jkt, undefined);
    }
    if (form.grant_type === "refresh_token") return this.refresh(req, res, String(form.refresh_token), requested, proof.jkt);
    json(res, 400, { error: "unsupported_grant_type" });
  }

  private mint(res: http.ServerResponse, authorized: string[], requested: string[], jkt: string, nonce: string | undefined): void {
    const target = this.target(authorized, requested);
    if (target === undefined) return json(res, 400, { error: "invalid_target" });
    const grant: Grant = { id: this.grants.length + 1, jkt, resources: authorized, refreshToken: `refresh-${++this.serial}`, rotated: new Map(), revoked: false };
    this.grants.push(grant);
    const account = this.options.account ?? { sub: "usr_alice", preferred_username: "alice" };
    const idToken = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: this.url, aud: "telo-cli", iat: 0, exp: 9_999_999_999, ...account, ...(nonce ? { nonce } : {}) })).toString("base64url"),
      "signature",
    ].join(".");
    json(res, 200, { ...this.tokens(grant.refreshToken), id_token: idToken });
  }

  private async refresh(req: http.IncomingMessage, res: http.ServerResponse, presented: string, requested: string[], jkt: string): Promise<void> {
    if (this.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
    if (this.refreshError !== undefined) return json(res, 400, { error: this.refreshError });
    const current = this.grants.find((grant) => grant.refreshToken === presented);
    const reused = this.grants.find((grant) => grant.rotated.has(presented));
    if (reused && !reused.revoked) {
      const rotation = reused.rotated.get(presented)!;
      if (Date.now() - rotation.at <= this.reuseWindowMs) {
        this.replays++;
        return json(res, rotation.answer.status, rotation.answer.body);
      }
      reused.revoked = true;
      return json(res, 400, { error: "invalid_grant", error_description: "refresh token reuse" });
    }
    if (!current || current.revoked) return json(res, 400, { error: "invalid_grant" });
    if (jkt !== current.jkt) return json(res, 400, { error: "invalid_dpop_proof" });
    if (this.target(current.resources, requested) === undefined) return json(res, 400, { error: "invalid_target" });
    const next = `refresh-${++this.serial}`;
    const answer: Answer = { status: 200, body: this.tokens(next) };
    current.rotated.set(presented, { at: Date.now(), answer });
    current.refreshToken = next;
    this.refreshes++;
    if (this.dropRefreshAnswers > 0) {
      this.dropRefreshAnswers--;
      req.socket.destroy();
      return;
    }
    json(res, answer.status, answer.body);
  }

  /** The one resource a token request targets, as accounts decides it. */
  private target(authorized: string[], requested: string[]): string | undefined {
    if (requested.length === 1) return authorized.includes(requested[0]!) ? requested[0] : undefined;
    return authorized.length === 1 ? authorized[0] : undefined;
  }

  private tokens(refreshToken: string): Record<string, unknown> {
    return { access_token: `access-${++this.serial}`, token_type: "DPoP", expires_in: this.accessTokenTtl, refresh_token: refreshToken, scope: "offline_access runner:sessions" };
  }
}

/** A DPoP proof's claims and key thumbprint, when its signature holds for `htu`. */
export function verifyProof(proof: string, htu: string, accessToken?: string): { jkt: string; nonce: unknown; payload: Record<string, unknown> } | undefined {
  const [header, payload, signature] = proof.split(".");
  if (!header || !payload || !signature) return undefined;
  const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { typ: string; alg: string; jwk: JsonWebKey };
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  if (head.typ !== "dpop+jwt" || head.alg !== "ES256") return undefined;
  const key = createPublicKey({ key: head.jwk, format: "jwk" });
  const valid = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  if (!valid || claims.htu !== htu || typeof claims.jti !== "string") return undefined;
  if (accessToken !== undefined && claims.ath !== createHash("sha256").update(accessToken, "ascii").digest("base64url")) return undefined;
  const { crv, kty, x, y } = head.jwk;
  return { jkt: createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url"), nonce: claims.nonce, payload: claims };
}

function formOf(text: string): Record<string, string | string[]> {
  const params = new URLSearchParams(text);
  const form: Record<string, string | string[]> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    form[name] = values.length > 1 ? values : values[0]!;
  }
  return form;
}

function asList(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : value;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
