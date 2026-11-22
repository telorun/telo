import { SignatureMalformed } from "./signature-failure.js";
import {
  isInnerList,
  parseDictionary,
  serializeInnerList,
  StructuredFieldError,
  type BareItem,
  type Item,
} from "./structured-fields.js";

/** One signature of a `Signature-Input` field. */
export interface SignatureInput {
  label: string;
  components: Item[];
  /** The serialized inner list and parameters: the `@signature-params` line's value. */
  signatureParams: string;
  keyId: string | null;
  algorithm: string | null;
  /** Seconds since the epoch. */
  created: number | null;
  expires: number | null;
}

function paramOf(params: Array<[string, BareItem]>, key: string, type: "string" | "integer"): string | number | null {
  const found = params.find(([name]) => name === key)?.[1];
  if (found === undefined) return null;
  if (found.type !== type) throw new SignatureMalformed(`the signature parameter ${key} is not ${type === "string" ? "a string" : "an integer"}`);
  return found.value as string | number;
}

function structured<T>(read: () => T, field: string): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof StructuredFieldError) throw new SignatureMalformed(`${field} is not a structured field: ${error.message}`);
    throw error;
  }
}

/** Reads `Signature-Input` (RFC 9421 §4.1): each member an inner list of components with signature parameters. */
export function parseSignatureInput(field: string): Map<string, SignatureInput> {
  const out = new Map<string, SignatureInput>();
  for (const [label, member] of structured(() => parseDictionary(field), "Signature-Input")) {
    if (!isInnerList(member)) throw new SignatureMalformed(`Signature-Input member ${label} is not a list of components`);
    out.set(label, {
      label,
      components: member.items,
      signatureParams: serializeInnerList(member),
      keyId: paramOf(member.params, "keyid", "string") as string | null,
      algorithm: paramOf(member.params, "alg", "string") as string | null,
      created: paramOf(member.params, "created", "integer") as number | null,
      expires: paramOf(member.params, "expires", "integer") as number | null,
    });
  }
  return out;
}

/** Reads `Signature` (RFC 9421 §4.2): each member a byte sequence. */
export function parseSignatures(field: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [label, member] of structured(() => parseDictionary(field), "Signature")) {
    if (isInnerList(member) || member.value.type !== "bytes") throw new SignatureMalformed(`Signature member ${label} is not a byte sequence`);
    out.set(label, member.value.value);
  }
  return out;
}
