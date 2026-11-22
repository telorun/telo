import { celTimestampFromMillis, isCelTimestamp, type CelTimestamp } from "@telorun/sdk";
import { buildSignatureBase, requiredComponentId, checkComponent } from "./signature-base.js";
import { verifyContentDigest } from "./content-digest.js";
import { headerValue, type RequestDescription } from "./request-description.js";
import { SignatureMalformed } from "./signature-failure.js";
import { parseSignatureInput, parseSignatures } from "./signature-headers.js";
import type { SignatureReading } from "./signature-reading.js";

export interface MessageSignatureOptions {
  /** The signature to read; without one the request must carry exactly one. */
  label?: string;
  /** What the signature must cover: `@method`, `content-digest`, `@query-param;name="x"`, … */
  components: readonly string[];
  /** Check `Content-Digest` against the request body when the signature covers it; without it the covered field is only a base line and the body stays unauthenticated. */
  verifyContentDigest?: boolean;
}

export function timestampOfSeconds(seconds: number): CelTimestamp {
  const value = celTimestampFromMillis(seconds * 1000);
  if (!isCelTimestamp(value)) throw new SignatureMalformed("a signature time is outside the range a timestamp holds");
  return value;
}

/**
 * Reads an RFC 9421 message signature off a request: selects the signature,
 * holds it to the required coverage, builds its signature base and, when asked
 * to and the signature covers `content-digest`, checks that field against the body.
 */
export function readMessageSignature(request: RequestDescription, options: MessageSignatureOptions): SignatureReading {
  const required = options.components.map(requiredComponentId);
  try {
    const signatureField = headerValue(request.headers, "signature");
    if (signatureField === undefined) return { status: "absent" };
    const signatures = parseSignatures(signatureField);
    const inputField = headerValue(request.headers, "signature-input");
    if (inputField === undefined) return { status: "malformed", reason: "the request has a Signature header and no Signature-Input" };
    const inputs = parseSignatureInput(inputField);

    let label = options.label;
    if (label === undefined) {
      if (signatures.size !== 1) return { status: "malformed", reason: `the request must carry exactly one signature, it carries ${signatures.size}` };
      label = [...signatures.keys()][0]!;
    } else if (!signatures.has(label)) {
      return { status: "absent" };
    }
    const input = inputs.get(label);
    if (input === undefined) return { status: "malformed", reason: `the signature ${label} has no Signature-Input member` };

    const covered = input.components.map(checkComponent);
    for (const id of required) {
      if (!covered.includes(id)) return { status: "malformed", reason: `the signature does not cover ${id}` };
    }
    if (options.verifyContentDigest === true && covered.includes('"content-digest"')) {
      const digest = headerValue(request.headers, "content-digest");
      const verdict = digest === undefined ? "unreadable" : verifyContentDigest(digest, request.body ?? new Uint8Array(0));
      if (verdict !== "match") return { status: "malformed", reason: `Content-Digest does not hold for the body (${verdict})` };
    }

    return {
      status: "ok",
      presentation: {
        type: "signature",
        base: buildSignatureBase(request, input.components, input.signatureParams),
        signatures: [signatures.get(label)!],
        keyId: input.keyId,
        algorithm: input.algorithm,
        created: input.created === null ? null : timestampOfSeconds(input.created),
        expires: input.expires === null ? null : timestampOfSeconds(input.expires),
      },
    };
  } catch (error) {
    if (error instanceof SignatureMalformed) return { status: "malformed", reason: error.message };
    throw error;
  }
}
