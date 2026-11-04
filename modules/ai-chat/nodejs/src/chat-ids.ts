import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 62^22 > 2^128, so 22 digits hold 128 random bits. */
const DIGITS = 22;

type Prefix = "cnv_" | "trn_" | "apr_" | "wrt_";

/** A public id: `prefix` + 128 random bits in fixed-width base 62. */
export function mintId(prefix: Prefix): string {
  let n = BigInt("0x" + randomBytes(16).toString("hex"));
  let out = "";
  for (let i = 0; i < DIGITS; i++) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return prefix + out;
}

/** Where an attachment's bytes are kept in the endpoint's blob store. */
export const attachmentKey = (id: string) => `attachments/${id}`;

/** How a stored message refers to an attachment. */
export const ATTACHMENT_SCHEME = "attachment:";
/** The relative reference a client resolves against the endpoint's base: the
 *  attachment read under the conversation holding it. */
export const attachmentUrl = (conversation: string, id: string) =>
  `conversations/${encodeURIComponent(conversation)}/attachments/${id}`;
