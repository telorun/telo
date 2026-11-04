import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 62^22 > 2^128, so 22 digits hold 128 random bits. */
const DIGITS = 22;

/** A public id: `prefix` + 128 random bits in fixed-width base 62. */
export function mintId(prefix: "cnv_" | "ent_" | "att_"): string {
  let n = BigInt("0x" + randomBytes(16).toString("hex"));
  let out = "";
  for (let i = 0; i < DIGITS; i++) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return prefix + out;
}

export const mintConversationId = () => mintId("cnv_");
export const mintEntryId = () => mintId("ent_");
export const mintAttachmentId = () => mintId("att_");
