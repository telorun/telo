import { createHash } from "node:crypto";
import { decodeKeyTail, encodeKeyTail } from "@telorun/graph";

/**
 * What a layered listing's tail carries beside its last key: the selectors
 * that say what the listing was read from. The key part is the text
 * `@telorun/graph`'s key tail writes and reads; a selector is re-checked in
 * code against what the same call could read with no cursor.
 */

function members(tail: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function keysOf(k: unknown, arity: number): unknown[] | undefined {
  return typeof k === "string" ? decodeKeyTail(k, arity) : undefined;
}

/** What an in-session listing was read from: the draft, by its public id, and
 *  the revision it stood on. A tail is re-checked against both before it is
 *  followed, so one never resumes over another draft, across a session
 *  boundary, or past a rebase. */
export interface TailSelector {
  readonly draft: string;
  readonly parent: string;
}

/** A tail that also names what the listing was read from. With no selector it
 *  is a listing of the published state. */
export function encodeSelectedTail(keys: readonly unknown[], selector?: TailSelector): string {
  const k = encodeKeyTail(keys);
  return JSON.stringify(selector ? { k, d: selector.draft, p: selector.parent } : { k });
}

export function decodeSelectedTail(
  tail: string,
  arity: number,
): { keys: unknown[]; selector?: TailSelector } | undefined {
  const parsed = members(tail);
  if (!parsed) return undefined;
  const { k, d, p, ...rest } = parsed;
  if (Object.keys(rest).length > 0) return undefined;
  const keys = keysOf(k, arity);
  if (!keys) return undefined;
  if (d === undefined && p === undefined) return { keys };
  if (typeof d !== "string" || typeof p !== "string" || !/^\d+$/.test(p)) return undefined;
  return { keys, selector: { draft: d, parent: p } };
}

/**
 * What a listing of a revisioned layer was read at: one of the layer's
 * published revisions — a read outside a session stays on the revision of its
 * first page, whose stack is immutable — or, inside a session, the draft, the
 * revision it stood on and a digest of its direct base list, since a draft's
 * pins can move.
 */
export type TailPin =
  | { readonly revision: string }
  | { readonly draft: string; readonly parent: string; readonly bases: string };

export function encodePinnedTail(keys: readonly unknown[], pin: TailPin): string {
  const k = encodeKeyTail(keys);
  return JSON.stringify(
    "draft" in pin ? { k, d: pin.draft, p: pin.parent, b: pin.bases } : { k, r: pin.revision },
  );
}

export function decodePinnedTail(
  tail: string,
  arity: number,
): { keys: unknown[]; pin: TailPin } | undefined {
  const parsed = members(tail);
  if (!parsed) return undefined;
  const { k, d, p, r, b, ...rest } = parsed;
  if (Object.keys(rest).length > 0) return undefined;
  const keys = keysOf(k, arity);
  if (!keys) return undefined;
  const revision = (value: unknown): value is string =>
    typeof value === "string" && /^\d{1,19}$/.test(value);
  const digest = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
  if (d === undefined && p === undefined && b === undefined && revision(r)) {
    return { keys, pin: { revision: r } };
  }
  if (r === undefined && typeof d === "string" && revision(p) && digest(b)) {
    return { keys, pin: { draft: d, parent: p, bases: b } };
  }
  return undefined;
}

/** The digest an in-session tail carries of the draft's direct base list:
 *  layer names and revision numbers, in position order. No internal id. */
export function baseListDigest(
  bases: readonly { readonly layer: string; readonly revision: bigint }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(bases.map((base) => [base.layer, base.revision.toString()])))
    .digest("base64url")
    .slice(0, 22);
}
