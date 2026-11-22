import { firstGroup } from "./patterns.js";
import { headerValue } from "./request-description.js";
import { SignatureMalformed } from "./signature-failure.js";

/** One part of a webhook's signed bytes: `HttpSignature.BasePart`. */
export type BasePart =
  | { type: "literal"; value: string }
  | { type: "header"; header: string; pattern?: string }
  | { type: "body" };

/** Concatenates the parts, with nothing between them. */
export function evaluateBaseParts(
  parts: readonly BasePart[],
  request: { headers: Record<string, string | string[] | undefined>; body?: Uint8Array | null },
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part.type === "literal") {
      chunks.push(encoder.encode(part.value));
    } else if (part.type === "body") {
      chunks.push(request.body ?? new Uint8Array(0));
    } else {
      const value = headerValue(request.headers, part.header);
      if (value === undefined) throw new SignatureMalformed(`the request has no ${part.header} header the signed bytes use`);
      const text = part.pattern === undefined ? value : firstGroup(part.pattern, value);
      if (text === undefined) throw new SignatureMalformed(`the ${part.header} header does not match the pattern its signed part names`);
      chunks.push(encoder.encode(text));
    }
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
