import { createHash } from "node:crypto";
import { encodeTypedFrame } from "@telorun/sdk";

/**
 * The digest a ledger stores for a call's `fingerprint`, or null when the call
 * makes no claim about its work (absent or null).
 *
 * The typed frame is the value domain's canonical text — object keys in RFC 8785
 * order — so two equal values give one digest whatever order their keys were
 * written in, and a value's CEL type is part of what is compared (`1` and `"1"`
 * differ).
 */
export function fingerprintDigest(fingerprint: unknown): string | null {
  if (fingerprint === undefined || fingerprint === null) return null;
  return createHash("sha256").update(encodeTypedFrame(fingerprint)).digest("hex");
}
