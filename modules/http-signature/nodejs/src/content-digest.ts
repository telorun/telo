import { createHash, timingSafeEqual } from "node:crypto";
import { parseDictionary, StructuredFieldError } from "./structured-fields.js";

const ALGORITHMS: Record<string, "sha256" | "sha512"> = { "sha-256": "sha256", "sha-512": "sha512" };

export type DigestVerdict = "match" | "mismatch" | "unreadable" | "unsupported";

/**
 * Checks a `Content-Digest` field (RFC 9530) against the body. Every supported
 * digest it lists must match; one that does not is a mismatch, and a field that
 * lists none this implementation computes (`sha-256`, `sha-512`) is `unsupported`.
 */
export function verifyContentDigest(field: string, body: Uint8Array): DigestVerdict {
  let dictionary;
  try {
    dictionary = parseDictionary(field);
  } catch (error) {
    if (error instanceof StructuredFieldError) return "unreadable";
    throw error;
  }
  let checked = 0;
  for (const [name, member] of dictionary) {
    const algorithm = ALGORITHMS[name];
    if (algorithm === undefined) continue;
    if ("items" in member || member.value.type !== "bytes") return "unreadable";
    const actual = createHash(algorithm).update(body).digest();
    const stated = Buffer.from(member.value.value);
    checked++;
    if (stated.length !== actual.length || !timingSafeEqual(stated, actual)) return "mismatch";
  }
  return checked === 0 ? "unsupported" : "match";
}
