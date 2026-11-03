import { ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";
import type { JWK } from "jose";
import {
  ERR_JOSE_REMOTE_KEYS_UNREACHABLE,
  type JoseKeys,
  type JsonWebKeySet,
  type KeyHint,
  type KeyMaterial,
} from "./key-set-contract.js";
import { KeyImports, publicPart, selectKeys } from "./jwk-selection.js";

export interface RemoteKeySetOptions {
  describe: string;
  /** Exactly one of the two. */
  url?: string;
  issuer?: string;
  cacheTtlMs: number;
  cooldownMs: number;
  timeoutMs: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** An algorithm a key can be import-checked under before any token names one. */
function probeAlgorithm(jwk: JWK): string | undefined {
  if (jwk.alg !== undefined) return jwk.alg;
  if (jwk.kty === "RSA") return "RS256";
  if (jwk.kty === "OKP") return "EdDSA";
  if (jwk.kty === "EC") return { "P-256": "ES256", "P-384": "ES384", "P-521": "ES512" }[jwk.crv ?? ""];
  return undefined;
}

interface Fetched {
  keys: { kid: string; jwk: JWK }[];
  fetchedAt: number;
}

/**
 * Someone else's published keys: a JWKS fetched from `url`, or from the
 * `jwks_uri` of `issuer`'s metadata document. Cached for `cacheTtl`, and
 * refetched early when a token names a kid the cache lacks — at most once per
 * `cooldown`, so random kids cannot turn every request into a fetch.
 */
export class RemoteKeySet implements JoseKeys {
  private fetched?: Fetched;
  private fetching?: Promise<Fetched>;
  private jwksUri?: Promise<string>;
  private readonly imports = new KeyImports();

  constructor(private readonly options: RemoteKeySetOptions) {}

  /** Nothing configured or observed here is safe or useful to publish. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  async verificationKeys(hint: KeyHint, signal?: AbortSignal): Promise<KeyMaterial[]> {
    let set = await this.current(signal);
    let found = selectKeys(set.keys, hint);
    if (found.length === 0 && Date.now() - set.fetchedAt >= this.options.cooldownMs) {
      set = await this.refresh(signal);
      found = selectKeys(set.keys, hint);
    }
    return Promise.all(found.map((entry) => this.imports.get(entry.jwk, hint.alg)));
  }

  async publicKeys(signal?: AbortSignal): Promise<JsonWebKeySet> {
    const set = await this.current(signal);
    return { keys: set.keys.map((entry) => entry.jwk) };
  }

  private current(signal?: AbortSignal): Promise<Fetched> {
    if (this.fetched && Date.now() - this.fetched.fetchedAt < this.options.cacheTtlMs) {
      return Promise.resolve(this.fetched);
    }
    return this.refresh(signal);
  }

  /** One fetch shared by every concurrent caller; a caller's cancellation abandons its wait, not the fetch. */
  private refresh(signal?: AbortSignal): Promise<Fetched> {
    this.fetching ??= this.fetchKeys().finally(() => (this.fetching = undefined));
    return abandonOnAbort(this.fetching, signal, this.options.describe);
  }

  private async fetchKeys(): Promise<Fetched> {
    const url = await this.resolveJwksUri();
    const document = await this.getJson(url);
    const keys = (document as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys)) {
      throw this.unreachable(`${url} did not return a JWKS (a JSON object with a \`keys\` list).`);
    }
    const usable: Fetched["keys"] = [];
    for (const entry of keys) {
      if (!entry || typeof entry !== "object" || typeof (entry as JWK).kty !== "string") continue;
      const jwk = entry as JWK;
      // Never take a symmetric secret from the network; it would let anyone who can read the JWKS sign.
      if (jwk.kty === "oct") continue;
      const candidate = { kid: jwk.kid ?? "", jwk: publicPart(jwk) };
      // A key that will not import (weak RSA, malformed EC) must not break every verification.
      const alg = probeAlgorithm(candidate.jwk);
      if (alg === undefined) continue;
      try {
        await this.imports.get(candidate.jwk, alg);
      } catch {
        continue;
      }
      usable.push(candidate);
    }
    this.fetched = { keys: usable, fetchedAt: Date.now() };
    return this.fetched;
  }

  private resolveJwksUri(): Promise<string> {
    if (this.options.url !== undefined) return Promise.resolve(this.options.url);
    this.jwksUri ??= this.discover().catch((err) => {
      this.jwksUri = undefined;
      throw err;
    });
    return this.jwksUri;
  }

  /** OpenID Connect discovery, then the RFC 8414 location. */
  private async discover(): Promise<string> {
    const issuer = this.options.issuer!;
    const trimmed = issuer.replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch (err) {
      throw this.unreachable(`issuer ${JSON.stringify(issuer)} is not a URL.`, err);
    }
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const locations = [
      `${trimmed}/.well-known/openid-configuration`,
      `${parsed.origin}/.well-known/oauth-authorization-server${path}`,
    ];
    const failures: string[] = [];
    for (const location of locations) {
      let document: unknown;
      try {
        document = await this.getJson(location);
      } catch (err) {
        failures.push((err as Error).message);
        continue;
      }
      const metadata = document as { issuer?: unknown; jwks_uri?: unknown } | null;
      if (metadata?.issuer !== issuer) {
        throw this.unreachable(
          `${location} declares issuer ${JSON.stringify(metadata?.issuer)}, not ${JSON.stringify(issuer)}. ` +
            `Set \`issuer\` to the value the server publishes.`,
        );
      }
      if (typeof metadata.jwks_uri !== "string") {
        throw this.unreachable(`${location} names no \`jwks_uri\`.`);
      }
      return metadata.jwks_uri;
    }
    throw this.unreachable(`no metadata document for issuer ${JSON.stringify(issuer)}: ${failures.join("; ")}`);
  }

  private async getJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      const reason = (err as Error).name === "TimeoutError"
        ? `no response within ${this.options.timeoutMs}ms`
        : (err as Error).cause instanceof Error
          ? ((err as Error).cause as Error).message
          : (err as Error).message;
      throw this.unreachable(`fetching ${url} failed: ${reason}.`, err);
    }
    if (!response.ok) throw this.unreachable(`${url} answered HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_BODY_BYTES) throw this.tooLarge(url);
    let body: string;
    try {
      body = await this.readBounded(response, url);
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      throw this.unreachable(`reading ${url} failed.`, err);
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw this.unreachable(`${url} returned a body that is not JSON.`, err);
    }
  }

  private async readBounded(response: Response, url: string): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw this.tooLarge(url);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private tooLarge(url: string): InvokeError {
    return this.unreachable(`${url} returned more than ${MAX_BODY_BYTES} bytes.`);
  }

  private unreachable(detail: string, cause?: unknown): InvokeError {
    return new InvokeError(
      ERR_JOSE_REMOTE_KEYS_UNREACHABLE,
      `${this.options.describe}: ${detail}`,
      undefined,
      cause === undefined ? undefined : { cause },
    );
  }
}

function abandonOnAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, describe: string): Promise<T> {
  if (!signal) return work;
  const cancelled = () =>
    new InvokeError(ERR_INVOKE_CANCELLED, `Cancelled while fetching the keys of ${describe}`);
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
