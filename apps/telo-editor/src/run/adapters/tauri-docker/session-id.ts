// Mirrors @telorun/runner-core's session-id format: a short 12-char lowercase
// base32 string, valid as a DNS label and an RFC 1123 container/pod name. Kept
// browser-safe (crypto.getRandomValues) — editor code must not import the
// node:crypto-based generator from runner-core.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SESSION_ID_LENGTH = 12;

export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH));
  let id = "";
  // 256 is a multiple of 32, so `byte % 32` indexes the alphabet without bias.
  for (let i = 0; i < SESSION_ID_LENGTH; i++) id += ALPHABET[bytes[i] % 32];
  return id;
}
