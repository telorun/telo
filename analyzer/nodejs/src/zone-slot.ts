/**
 * The single reader of the two execution-zone annotations —
 * `x-telo-provides-zone` and `x-telo-requires-zone` (see
 * `kernel/specs/execution-zones.md`). The analyzer's zone projection, the
 * kernel's `withZone` / `requireZone`, and any editor surface all recognise a
 * zone slot here and nowhere else, the same one-accessor rule `ref-slot.ts`
 * established for `x-telo-ref`. Browser-safe: no Node built-ins.
 *
 * Accepted shapes:
 *
 *   x-telo-provides-zone: true            # uncorrelated — the zone is the kind
 *   x-telo-provides-zone: /connection     # correlation-key pointer (own field)
 *   x-telo-provides-zone:                 # correlation key + zone attributes
 *     key: /connection
 *     atomic: a rollback erases writes a journal recorded as done
 *     noSuspend: the transaction holds a connection a parked run would lose
 *
 *   x-telo-requires-zone: Self.Transaction        # uncorrelated string form
 *   x-telo-requires-zone:                          # object form
 *     zone: Self.Transaction
 *     key: [/connection, /transaction/connection]  # ordered, first hit wins
 *     reason: the statement would execute outside any transaction
 */

import { ZONE_ATTRIBUTES, type ZoneAttributes } from "@telorun/sdk";

const PROVIDES = "x-telo-provides-zone";
const REQUIRES = "x-telo-requires-zone";

/** A body slot that establishes the declaring kind's zone when dispatched
 *  through. The zone's identity is always the declaring kind — the annotation
 *  never names one, so provision-on-behalf-of is unrepresentable. */
export interface ProvidesZoneSlot {
  /** Self-relative JSON pointer to the declaring kind's own field whose resolved
   *  reference the zone carries as its correlation payload. Absent =
   *  uncorrelated (`true`). */
  key?: string;
  /** What this zone declares about everything executed inside it, keyed by the
   *  closed vocabulary's bare names with the author's REASON as each value (see
   *  `sdk/zone-attributes/`). Empty for the two scalar spellings, which say
   *  nothing about their contents.
   *
   *  Read here and interpreted nowhere in this file: an attribute's meaning is
   *  entirely its consumer's — the containment walk, the step engine's collapse
   *  rule, the parking kinds — exactly as `readRefSlot` hands back `use` without
   *  acting on it. */
  attributes: ZoneAttributes;
}

/** A field declaring that its resource must be reached through a zone. */
export interface RequiresZoneSlot {
  /** The providing kind, alias-qualified as authored (`Self.Transaction`,
   *  `<Alias>.<Kind>`) — canonical `<module>.<Kind>` once
   *  `resolveSchemaRefKinds` has rewritten it in the declaring scope. */
  zone: string;
  /** Ordered self-relative JSON pointers tried in order, first hit winning; a
   *  pointer may traverse a `!ref` into the referenced resource's own field.
   *  Empty = uncorrelated. */
  key: string[];
  /** The runtime consequence, quoted after the path in diagnostics. */
  reason?: string;
}

/** A self-relative JSON Pointer — the only correlation-key spelling the
 *  analyzer and the kernel read identically. Applied to BOTH the scalar and the
 *  list form: the kernel's walk splits on `/` and drops empty segments, so a
 *  bare `connection` would resolve there while the checker skipped it, and the
 *  two halves would disagree about what the manifest means. `validate-zone-slots`
 *  reports what this rejects. */
function isPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length > 1;
}

/** Reads a schema node's provides-zone declaration, or undefined when it has
 *  none or the value is malformed (`validate-zone-slots` reports those). */
export function readProvidesZone(node: Record<string, any> | undefined): ProvidesZoneSlot | undefined {
  const raw = node?.[PROVIDES];
  if (raw === true) return { attributes: {} };
  if (isPointer(raw)) return { key: raw, attributes: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;
  // A `key` that is present but unreadable makes the object form MEAN something
  // different to the two halves — the correlation the author wrote is dropped
  // here while the kernel's walk still resolves a bare name — so the whole
  // annotation is refused rather than read as uncorrelated. Absent `key` is the
  // legitimate uncorrelated case.
  if (obj.key !== undefined && !isPointer(obj.key)) return undefined;

  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (name === "key") continue;
    // Unknown names and wrong-shaped values are reported by
    // `validate-zone-slots`; skipped here so a typo degrades to an attribute
    // this zone does not declare rather than to a consumer reading a name that
    // means nothing to it.
    if (!ZONE_ATTRIBUTES.has(name) || typeof value !== "string" || !value) continue;
    attributes[name] = value;
  }
  return { ...(isPointer(obj.key) ? { key: obj.key } : {}), attributes: attributes as ZoneAttributes };
}

/** The attributes the zone a slot provides declares, or an empty record when the
 *  node provides no zone. The shape every containment consumer wants, so none of
 *  them repeats the `readProvidesZone(...)?.attributes ?? {}` dance. */
export function providedZoneAttributes(node: Record<string, any> | undefined): ZoneAttributes {
  return readProvidesZone(node)?.attributes ?? {};
}

/** True when the node carries `x-telo-provides-zone` in any shape, valid or not
 *  — the recognition test validation needs before it judges the value. */
export function hasProvidesZone(node: Record<string, any> | undefined): boolean {
  return node?.[PROVIDES] !== undefined;
}

/** Reads a schema node's requires-zone declaration, or undefined when it has
 *  none or the value is malformed (`validate-zone-slots` reports those). */
export function readRequiresZone(node: Record<string, any> | undefined): RequiresZoneSlot | undefined {
  const raw = node?.[REQUIRES];
  if (typeof raw === "string" && raw) return { zone: raw, key: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.zone !== "string" || !obj.zone) return undefined;
  // One filter for both spellings — see `isPointer`.
  const key = (Array.isArray(obj.key) ? obj.key : [obj.key]).filter(isPointer);
  const slot: RequiresZoneSlot = { zone: obj.zone, key };
  if (typeof obj.reason === "string") slot.reason = obj.reason;
  return slot;
}

/** True when the node carries `x-telo-requires-zone` in any shape. */
export function hasRequiresZone(node: Record<string, any> | undefined): boolean {
  return node?.[REQUIRES] !== undefined;
}

/**
 * Rewrites the requires-zone kind name in place, in whichever shape it is
 * written — the write-side twin of {@link readRequiresZone}, mirroring
 * `rewriteRefSlotKinds` so `resolveSchemaRefKinds` canonicalizes both
 * annotations in one walk. `map` returns the replacement or `undefined` to
 * leave the authored name untouched (idempotence + quotable diagnostics).
 */
export function rewriteRequiresZoneKind(
  annotationHolder: Record<string, any>,
  map: (kind: string) => string | undefined,
): void {
  const raw = annotationHolder[REQUIRES];
  if (typeof raw === "string") {
    const next = map(raw);
    if (next !== undefined) annotationHolder[REQUIRES] = next;
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.zone === "string") {
    const next = map(obj.zone);
    if (next !== undefined) obj.zone = next;
  }
}
