import { InvokeError } from "@telorun/sdk";

export const ERR_MULTIPART_MALFORMED = "ERR_MULTIPART_MALFORMED";
export const ERR_MULTIPART_LIMIT_EXCEEDED = "ERR_MULTIPART_LIMIT_EXCEEDED";
export const ERR_MULTIPART_PART_MISSING = "ERR_MULTIPART_PART_MISSING";

export type MalformedReason =
  | "boundary-missing"
  | "truncated"
  | "header-malformed"
  | "header-too-large";

/** The input each limit is named by, which is also what `error.data.limit` says. */
export type LimitName = "maxPartBytes" | "maxParts" | "maxTotalBytes";

/** `who` names the kind, so the message points at the resource the author declared. */
export function malformed(who: string, reason: MalformedReason, message: string): InvokeError {
  return new InvokeError(ERR_MULTIPART_MALFORMED, `${who}: ${message}`, { reason });
}

/** `part` is the zero-based position of the part the limit was met at, with its
 *  form field name when it declared one. */
export function limitExceeded(
  who: string,
  limit: LimitName,
  max: number,
  message: string,
  part?: { index: number; name?: string },
): InvokeError {
  return new InvokeError(ERR_MULTIPART_LIMIT_EXCEEDED, `${who}: ${message}`, {
    limit,
    max,
    ...(part === undefined ? {} : { part: part.index }),
    ...(part?.name === undefined ? {} : { name: part.name }),
  });
}

/** The payload ended at its closing boundary with no part named `name`. */
export function partMissing(who: string, name: string): InvokeError {
  return new InvokeError(ERR_MULTIPART_PART_MISSING, `${who}: the payload holds no part named '${name}'.`, { name });
}
