import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 128 random bits need 22 base-62 digits. */
const DIGITS = 22;

/** A fresh message id: `msg_` and 128 random bits in base 62, fixed width. */
export function mintMessageId(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let digits = "";
  for (let i = 0; i < DIGITS; i++) {
    digits = BASE62[Number(value % 62n)] + digits;
    value /= 62n;
  }
  return `msg_${digits}`;
}
