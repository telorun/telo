import type { CelTimestamp } from "@telorun/sdk";

/** The `signature` presentation a transport hands a verifier. */
export interface SignaturePresentation {
  type: "signature";
  base: Uint8Array;
  signatures: Uint8Array[];
  keyId: string | null;
  algorithm: string | null;
  created: CelTimestamp | null;
  expires: CelTimestamp | null;
}

/**
 * What reading a request's signature yields. `absent` is "no credential" (the
 * signature header is missing); `malformed` is a signature that is present and
 * cannot be read or does not hold what the source requires, and carries a
 * reason that never repeats the value.
 */
export type SignatureReading =
  | { status: "absent" }
  | { status: "malformed"; reason: string }
  | { status: "ok"; presentation: SignaturePresentation };
