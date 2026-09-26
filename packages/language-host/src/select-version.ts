import type { RequirementsParams } from "@telorun/editor-protocol";
import { comparePlainVersions, intervalAccepts } from "./plain-version.js";
import type { UnofferedReason, VersionCatalog } from "./version-catalog.js";
import { knownVersions } from "./version-catalog.js";

/** Why a version was chosen — what a status line shows beside "Telo X". */
export type SelectionReason =
  /** `telo.version` names it. */
  | { kind: "pinned" }
  /** Rule 1: the lowest known version the owner's own range and every closure
   *  range accept. `range` is the owner's, as written. */
  | { kind: "owner-range"; range: string }
  /** Rule 2: the owner declares no range and the bundled version satisfies the
   *  closure (or there is no range at all). */
  | { kind: "bundled" }
  /** Rule 2: the owner declares no range and the bundled version does not
   *  satisfy the closure — the lowest known version that does. */
  | { kind: "closure-range"; ranges: string[] }
  /** Rule 3: no known version satisfies the closure; the bundled one runs so
   *  its load gate reports the refusing block. */
  | { kind: "unsatisfiable"; ranges: string[] };

export interface Selection {
  version: string;
  reason: SelectionReason;
}

/** A pin naming a version this host does not offer. */
export interface PinRefusal {
  pin: string;
  reason: UnofferedReason | "unpublished";
}

export type SelectionOutcome = Selection | { refused: PinRefusal };

/**
 * The telo version one owner module is edited against.
 *
 * `requirements` is the last `telo/requirements` for the owner (absent before
 * the first analysis). Ranges arrive as normalized intervals and are compared
 * by precedence only — range text is never parsed here. Versions are engine
 * identities: of two with equal precedence (a published `X` and a bundled
 * `X+unreleased`) the published one is the lower candidate, and only rule 2's
 * "the bundled version, when the closure accepts it" picks the bundled one. A
 * pin names an identity exactly; it is always honoured when offered, and a pin
 * naming anything else is refused with its reason, never replaced.
 *
 * Auto needs the bundled identity (rules 2 and 3 fall back to it); a caller
 * asks only once the bundled engine has identified itself.
 */
export function selectVersion(input: {
  catalog: VersionCatalog;
  requirements?: RequirementsParams;
  pin?: string;
}): SelectionOutcome {
  const { catalog, requirements, pin } = input;
  const known = knownVersions(catalog);

  if (pin !== undefined) {
    if (known.includes(pin)) return { version: pin, reason: { kind: "pinned" } };
    const unoffered = catalog.unoffered[pin];
    // An offline catalog cannot say a version is unpublished; the pin is then
    // taken as written and its engine fetch is what fails.
    if (unoffered === undefined && catalog.source !== "registry") {
      return { version: pin, reason: { kind: "pinned" } };
    }
    return { refused: { pin, reason: unoffered ?? "unpublished" } };
  }

  const bundled = catalog.bundled;
  if (bundled === undefined) {
    throw new Error("Auto selection needs the bundled engine's identity, which it has not reported.");
  }
  const ranges = requirements?.ranges ?? [];
  const owned = ranges.find((r) => r.module === requirements?.owner);
  const acceptedByAll = (version: string) => ranges.every((r) => intervalAccepts(r.interval, version));
  // `known` is newest first with the published one first on a tie, so its
  // reverse would put the bundled one first; re-sort to keep published first.
  const published = new Set(catalog.offered.map((e) => e.version));
  const lowestAccepted = [...known]
    .sort((a, b) => comparePlainVersions(a, b) || Number(published.has(b)) - Number(published.has(a)))
    .find(acceptedByAll);
  const texts = ranges.map((r) => r.text);

  if (owned) {
    return lowestAccepted === undefined
      ? { version: bundled, reason: { kind: "unsatisfiable", ranges: texts } }
      : { version: lowestAccepted, reason: { kind: "owner-range", range: owned.text } };
  }
  if (acceptedByAll(bundled)) return { version: bundled, reason: { kind: "bundled" } };
  return lowestAccepted === undefined
    ? { version: bundled, reason: { kind: "unsatisfiable", ranges: texts } }
    : { version: lowestAccepted, reason: { kind: "closure-range", ranges: texts } };
}
