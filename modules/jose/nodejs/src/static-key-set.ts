import { InvokeError, RuntimeError } from "@telorun/sdk";
import { calculateJwkThumbprint, importJWK, type JWK } from "jose";
import {
  ERR_JOSE_ALGORITHM_UNSUPPORTED,
  ERR_JOSE_KEYSET_UNAVAILABLE,
  type JoseKeySet,
  type JsonWebKeySet,
  type KeyHint,
  type KeyMaterial,
  type RotationOutcome,
  type SigningKey,
} from "./key-set-contract.js";
import {
  isPrivate,
  isSymmetric,
  KeyImports,
  publicJwk,
  selectKeys,
  servesAlgorithm,
  type SigningAlgorithm,
} from "./jwk-selection.js";

interface StaticKey {
  kid: string;
  /** The key as given, private members included. */
  jwk: JWK;
  /** What verification imports: the public half, or the secret of a symmetric key. */
  verifying: JWK;
}

/** A key set whose JWKs come from configuration: no store, no rotation. */
export class StaticKeySet implements JoseKeySet {
  private readonly imports = new KeyImports();

  private constructor(
    private readonly describe: string,
    private readonly algorithm: SigningAlgorithm,
    private readonly keys: StaticKey[],
  ) {}

  /** Nothing configured or observed here is safe or useful to publish. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  /** Every key must be a JWK of the configured algorithm's type, and import as one. */
  static async create(describe: string, algorithm: SigningAlgorithm, given: unknown[]): Promise<StaticKeySet> {
    const keys: StaticKey[] = [];
    for (const [index, entry] of given.entries()) {
      const at = `${describe}: keys[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as JWK).kty !== "string") {
        throw new RuntimeError(ERR_JOSE_ALGORITHM_UNSUPPORTED, `${at} is not a JWK (an object with a \`kty\`).`);
      }
      const jwk = entry as JWK;
      if (!servesAlgorithm(jwk, algorithm)) {
        throw new RuntimeError(
          ERR_JOSE_ALGORITHM_UNSUPPORTED,
          `${at} cannot serve ${algorithm}: it is a ${jwk.kty}${jwk.crv ? ` ${jwk.crv}` : ""} key` +
            `${jwk.alg ? ` for ${jwk.alg}` : ""}${jwk.use && jwk.use !== "sig" ? ` restricted to use "${jwk.use}"` : ""}.`,
        );
      }
      const verifying = isSymmetric(algorithm) ? jwk : publicJwk(jwk, "", algorithm);
      try {
        await importJWK(isPrivate(jwk) ? jwk : verifying, algorithm);
      } catch (err) {
        throw new RuntimeError(
          ERR_JOSE_ALGORITHM_UNSUPPORTED,
          `${at} does not import as a ${algorithm} key: ${(err as Error).message}`,
        );
      }
      const kid = jwk.kid ?? (await calculateJwkThumbprint(verifying));
      keys.push({ kid, jwk, verifying: isSymmetric(algorithm) ? jwk : publicJwk(jwk, kid, algorithm) });
    }
    return new StaticKeySet(describe, algorithm, keys);
  }

  async verificationKeys(hint: KeyHint): Promise<KeyMaterial[]> {
    return Promise.all(
      selectKeys(this.keys, hint).map((entry) => this.imports.get(entry.verifying, hint.alg)),
    );
  }

  async publicKeys(): Promise<JsonWebKeySet> {
    if (isSymmetric(this.algorithm)) return { keys: [] };
    return { keys: this.keys.map((entry) => entry.verifying) };
  }

  async signingKey(): Promise<SigningKey> {
    const signer = this.keys.find((entry) => isPrivate(entry.jwk));
    if (!signer) {
      throw new InvokeError(
        ERR_JOSE_KEYSET_UNAVAILABLE,
        `${this.describe} holds no private key to sign with; its keys only verify.`,
      );
    }
    return { kid: signer.kid, alg: this.algorithm, key: await this.imports.get(signer.jwk, this.algorithm) };
  }

  async rotate(): Promise<RotationOutcome> {
    throw new InvokeError(
      ERR_JOSE_KEYSET_UNAVAILABLE,
      `${this.describe} is a static key set (\`keys:\`) and cannot rotate. Rotate its keys where they come from, or give it a \`store\`.`,
    );
  }
}
