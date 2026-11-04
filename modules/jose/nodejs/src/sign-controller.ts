import { randomValue } from "@telorun/crypto";
import { celTimestampFromMillis, toPlainJson } from "@telorun/sdk";
import { SignJWT, type JWTPayload } from "jose";
import { durationSetting } from "./duration-setting.js";
import { isJoseKeySet } from "./key-set-contract.js";
import { operationController, type Named } from "./operation-controller.js";

interface SignResource extends Named {
  keys: unknown;
  type?: string;
  issuer?: string;
  audience?: string | string[];
  expiresIn?: unknown;
  notBefore?: unknown;
}

interface SignInputs {
  claims?: Record<string, unknown>;
  subject?: string;
  audience?: string | string[];
  expiresIn?: unknown;
  jwtId?: string;
}

const DEFAULT_EXPIRES_IN_MS = 15 * 60 * 1000;

export const { register, create } = operationController<SignResource, SignInputs, unknown>(
  "Jose.Sign",
  (config, ctx, describe) => {
    const defaultExpiresInMs = durationSetting(config.expiresIn, DEFAULT_EXPIRES_IN_MS, () => `${describe}: 'expiresIn'`);
    const notBeforeMs = durationSetting(config.notBefore, 0, () => `${describe}: 'notBefore'`);
    return async (inputs: SignInputs) => {
      const keys = ctx.resolveRef(config.keys, isJoseKeySet, () => `${describe}: 'keys'`, "Jose.KeySet");
      const signer = await keys.signingKey();
      const nowMs = Date.now();
      const nowSeconds = Math.floor(nowMs / 1000);
      const expiresInMs = durationSetting(inputs.expiresIn, defaultExpiresInMs, () => `${describe}: input 'expiresIn'`);
      const expiresAt = nowSeconds + Math.ceil(expiresInMs / 1000);

      const jwt = new SignJWT(toPlainJson(inputs.claims ?? {}) as JWTPayload)
        .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: config.type ?? "JWT" })
        .setIssuedAt(nowSeconds)
        .setExpirationTime(expiresAt);
      if (notBeforeMs > 0) jwt.setNotBefore(nowSeconds + Math.floor(notBeforeMs / 1000));
      if (config.issuer !== undefined) jwt.setIssuer(config.issuer);
      const audience = inputs.audience ?? config.audience;
      if (audience !== undefined) jwt.setAudience(audience);
      if (inputs.subject !== undefined) jwt.setSubject(inputs.subject);
      if (inputs.jwtId !== undefined) {
        jwt.setJti(inputs.jwtId === "auto" ? randomValue(16, "base64url") : inputs.jwtId);
      }
      return {
        token: await jwt.sign(signer.key),
        kid: signer.kid,
        expiresAt: celTimestampFromMillis(expiresAt * 1000),
      };
    };
  },
);
