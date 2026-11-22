import { createHash, timingSafeEqual } from "node:crypto";
import {
  durationMs,
  isCelTimestamp,
  RuntimeError,
  timestampNanos,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { prepareKey, type KeyResource, type SignatureKey } from "./signature-keys.js";

interface VerifierResource {
  metadata: { name: string };
  keys: KeyResource[];
  maxSignatureAge?: unknown;
  clockTolerance?: unknown;
}

interface SignatureInputs {
  presentation: {
    base: Uint8Array;
    signatures: Uint8Array[];
    keyId?: string | null;
    algorithm?: string | null;
    created?: unknown;
    expires?: unknown;
  };
}

export type RefusalReason = "unknownKey" | "algorithm" | "signature" | "stale" | "expired";

const DEFAULT_CLOCK_TOLERANCE_MS = 30_000;

function setting(value: unknown, fallback: number | null, describe: string): number | null {
  if (value === undefined || value === null) return fallback;
  const ms = durationMs(value);
  if (ms === undefined) throw new RuntimeError("ERR_INVALID_VALUE", `${describe} must be a duration.`);
  return ms;
}

function instantMs(value: unknown, member: string, describe: string): number | null {
  if (value === undefined || value === null) return null;
  if (!isCelTimestamp(value)) throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: '${member}' must be a timestamp.`);
  return Number(timestampNanos(value) / 1_000_000n);
}

// Digests of equal length, so the comparison never depends on where two ids differ.
const digestOf = (text: string) => createHash("sha256").update(text).digest();
const sameId = (a: string, b: string) => timingSafeEqual(digestOf(a), digestOf(b));

const refuse = (reason: RefusalReason) => ({ refused: true as const, reason, challenge: null });

export function register(): void {}

export async function create(resource: VerifierResource, ctx: ResourceContext): Promise<ResourceInstance> {
  void ctx;
  const name = String(resource.metadata.name);
  const describe = `AuthSignature.Verifier "${name}"`;
  const keys = resource.keys.map((entry, index) => prepareKey(entry, `${describe}: keys[${index}]`));
  const maxAgeMs = setting(resource.maxSignatureAge, null, `${describe}: 'maxSignatureAge'`);
  const toleranceMs = setting(resource.clockTolerance, DEFAULT_CLOCK_TOLERANCE_MS, `${describe}: 'clockTolerance'`)!;

  function candidates(keyId: string | null | undefined): SignatureKey[] {
    return keyId === null || keyId === undefined
      ? keys.filter((key) => key.id === null)
      : keys.filter((key) => key.id !== null && sameId(key.id, keyId));
  }

  return {
    async invoke(inputs: Record<string, any>) {
      const { presentation } = inputs as SignatureInputs;
      const nowMs = Date.now();

      const named = candidates(presentation.keyId);
      if (named.length === 0) return refuse("unknownKey");
      const claimed = presentation.algorithm ?? null;
      const eligible = claimed === null ? named : named.filter((key) => key.algorithm === claimed);
      if (eligible.length === 0) return refuse("algorithm");

      // Every key and signature is checked, so how long this takes does not say which one matched.
      let matched: SignatureKey | null = null;
      for (const key of eligible) {
        for (const signature of presentation.signatures) {
          if (key.check(presentation.base, signature) && matched === null) matched = key;
        }
      }
      if (matched === null) return refuse("signature");

      const expiresMs = instantMs(presentation.expires, "expires", describe);
      if (expiresMs !== null && nowMs > expiresMs + toleranceMs) return refuse("expired");

      if (maxAgeMs !== null) {
        const createdMs = instantMs(presentation.created, "created", describe);
        if (createdMs === null || nowMs - createdMs > maxAgeMs + toleranceMs || createdMs - nowMs > toleranceMs) {
          return refuse("stale");
        }
      }

      return {
        principal: {
          subject: matched.subject,
          issuer: null,
          kind: "service" as const,
          claims: {},
          scopes: [],
          roles: [],
          permissions: [],
          org: null,
          amr: [],
          acr: null,
          sessionId: null,
          authenticatedAt: null,
          via: name,
        },
      };
    },
    snapshot() {
      return { challenges: [] };
    },
  };
}
