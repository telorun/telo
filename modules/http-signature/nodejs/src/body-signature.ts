import { evaluateBaseParts, type BasePart } from "./base-parts.js";
import { timestampOfSeconds } from "./message-signature.js";
import { allFirstGroups, firstGroup } from "./patterns.js";
import { headerValue, type RequestDescription } from "./request-description.js";
import { SignatureMalformed } from "./signature-failure.js";
import type { SignatureReading } from "./signature-reading.js";
import { celTimestampFromMillis, isCelTimestamp } from "@telorun/sdk";

export type SignatureEncoding = "hex" | "base64" | "base64url";

export interface BodySignatureOptions {
  signature: { header: string; pattern?: string; encoding: SignatureEncoding };
  timestamp?: { header: string; pattern?: string; unit: "seconds" | "milliseconds" };
  base: readonly BasePart[];
}

const DECODERS: Record<SignatureEncoding, RegExp> = {
  hex: /^(?:[0-9a-fA-F]{2})+$/,
  base64: /^[A-Za-z0-9+/]+={0,2}$/,
  base64url: /^[A-Za-z0-9_-]+={0,2}$/,
};

export function decodeSignature(text: string, encoding: SignatureEncoding): Uint8Array {
  if (!DECODERS[encoding].test(text)) throw new SignatureMalformed(`a signature is not ${encoding}`);
  return new Uint8Array(Buffer.from(text, encoding));
}

function readTimestamp(request: RequestDescription, options: NonNullable<BodySignatureOptions["timestamp"]>) {
  const value = headerValue(request.headers, options.header);
  const text = value === undefined || options.pattern === undefined ? value : firstGroup(options.pattern, value);
  if (text === undefined || !/^\d{1,16}$/.test(text)) throw new SignatureMalformed(`the ${options.header} header holds no readable timestamp`);
  if (options.unit === "seconds") return timestampOfSeconds(Number(text));
  const timestamp = celTimestampFromMillis(Number(text));
  if (!isCelTimestamp(timestamp)) throw new SignatureMalformed("a signature time is outside the range a timestamp holds");
  return timestamp;
}

/**
 * Reads a webhook signature (a header holding the signature, optionally a
 * timestamp, the provider's signed bytes assembled from the parts of `base`).
 * Every signature the header's pattern captures is presented.
 */
export function readBodySignature(request: RequestDescription, options: BodySignatureOptions): SignatureReading {
  try {
    const field = headerValue(request.headers, options.signature.header);
    if (field === undefined) return { status: "absent" };
    const texts = options.signature.pattern === undefined ? [field] : allFirstGroups(options.signature.pattern, field);
    if (texts.length === 0) return { status: "malformed", reason: `the ${options.signature.header} header holds no signature` };
    return {
      status: "ok",
      presentation: {
        type: "signature",
        base: evaluateBaseParts(options.base, request),
        signatures: texts.map((text) => decodeSignature(text, options.signature.encoding)),
        keyId: null,
        algorithm: null,
        created: options.timestamp === undefined ? null : readTimestamp(request, options.timestamp),
        expires: null,
      },
    };
  } catch (error) {
    if (error instanceof SignatureMalformed) return { status: "malformed", reason: error.message };
    throw error;
  }
}
