import { toPlainJson, type ResourceManifest } from "@telorun/sdk";
import { durationSetting } from "./duration-setting.js";
import type { DpopSettings } from "./dpop-proof.js";

/** The keys `AuthBearer.AccessTokenVerifier` declares once for every verifier. */
export interface AccessTokenResource extends ResourceManifest {
  audience: unknown;
  confirmation?: {
    dpop?: { required?: boolean; replay: unknown; maxProofAge?: unknown; algorithms: string[] };
    certificateBound?: boolean;
  };
  revocation?: { store: unknown };
  principal?: {
    kind?: unknown;
    scopes?: unknown;
    roles?: unknown;
    permissions?: unknown;
    org?: unknown;
  };
}

export interface AccessTokenSettings {
  describe: string;
  via: string;
  audience: unknown;
  dpop: (DpopSettings & { required: boolean; replay: unknown }) | null;
  certificateBound: boolean;
  revocationStore: unknown;
  principal: NonNullable<AccessTokenResource["principal"]>;
}

const DEFAULT_MAX_PROOF_AGE_MS = 60_000;

export function readAccessTokenSettings(
  resource: AccessTokenResource,
  kind: string,
): AccessTokenSettings {
  const describe = `${kind} "${resource.metadata.name}"`;
  const dpop = resource.confirmation?.dpop;
  return {
    describe,
    via: String(resource.metadata.name),
    audience: resource.audience,
    dpop: dpop
      ? {
          required: dpop.required ?? false,
          replay: dpop.replay,
          algorithms: dpop.algorithms,
          maxProofAgeMs: durationSetting(
            dpop.maxProofAge,
            DEFAULT_MAX_PROOF_AGE_MS,
            () => `${describe}: 'confirmation.dpop.maxProofAge'`,
          ),
        }
      : null,
    certificateBound: resource.confirmation?.certificateBound ?? false,
    revocationStore: resource.revocation?.store,
    principal: resource.principal ?? {},
  };
}

/** The issuer a `Telo.Url` or string setting holds, as text. */
export function issuerText(value: unknown): string {
  return toPlainJson(value) as string;
}
