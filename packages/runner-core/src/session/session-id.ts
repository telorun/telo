import { randomBytes } from "node:crypto";

// Lowercase RFC 4648 base32 alphabet. Every character is valid in a DNS label
// and an RFC 1123 Kubernetes resource name, so the id drops straight into both
// `<id>.<domain>` session hostnames and `telo-run-<id>` container/pod names.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// 12 chars × 5 bits ≈ 60 bits of entropy. Collisions are negligible across the
// concurrently-active session set (there is no dedup check, so the id must be
// unique on its own) while staying far shorter than the previous UUID.
const SESSION_ID_LENGTH = 12;

/** Generates a short, DNS- and Kubernetes-safe session id. */
export function generateSessionId(): string {
  const bytes = randomBytes(SESSION_ID_LENGTH);
  let id = "";
  // 256 is a multiple of 32, so `byte % 32` indexes the alphabet without bias.
  for (let i = 0; i < SESSION_ID_LENGTH; i++) id += ALPHABET[bytes[i] % 32];
  return id;
}
