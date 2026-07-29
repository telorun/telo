import { createHash, randomBytes } from "node:crypto";
import type { PkceMode } from "./client.js";

/** base64url per RFC 7636 §A: base64 with the URL alphabet and no padding. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A one-time value binding a callback to the request that produced it. */
export function randomState(): string {
  return base64url(randomBytes(32));
}

/** The verifier is the secret kept by the program; 32 random bytes lands inside
 *  RFC 7636's 43–128 character range once base64url-encoded. */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** The challenge is what travels in the consent URL — a hash of the verifier
 *  under `S256`, so an intercepted URL does not reveal the secret. */
export function challengeFor(mode: PkceMode, verifier: string): { value: string; method: string } {
  if (mode === "plain") return { value: verifier, method: "plain" };
  return { value: base64url(createHash("sha256").update(verifier).digest()), method: "S256" };
}
