import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64url");

/** A code is digested together with its subject, so one digest cannot be replayed on another subject. */
export const codeDigest = (subject: string, code: string): string => sha256(`${sha256(subject)}\u0000${code}`);

/** Whether two digests are equal, in time independent of where they differ. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export const mintLinkSecret = (bytes: number): string => randomBytes(bytes).toString("base64url");

export const mintCode = (digits: number): string => String(randomInt(0, 10 ** digits)).padStart(digits, "0");
