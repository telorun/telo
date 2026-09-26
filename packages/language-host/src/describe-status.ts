import type { MarkedVersion, TeloStatus, VersionMarks } from "./language-router.js";
import { parseEngineIdentity } from "./plain-version.js";

/** How a host names itself and its version setting in the sentences below. */
export interface TeloStatusHost {
  /** What ships the bundled engine: `this extension`, `studio`. */
  product: string;
  /** Where the version is pinned: `the telo.version setting`. */
  setting: string;
}

/** A short label and the sentence behind it. */
export interface TeloStatusText {
  label: string;
  detail: string;
}

/** `0.102.0`, or `0.102.0 (unreleased build)` for an engine identity carrying
 *  build metadata — a build made before its release, which is not the
 *  published engine of that number. */
export function describeEngineVersion(version: string): string {
  const identity = parseEngineIdentity(version);
  return identity?.build === undefined ? version : `${version.slice(0, version.indexOf("+"))} (unreleased build)`;
}

/**
 * What the active document is edited against, in words every host shows the
 * same way: the label for a status item ("Telo 0.102.0 (pinned)") and the
 * sentence saying what chose that version, that its engine is starting, or
 * the error state. A host adds only icons and actions.
 */
export function describeTeloStatus(status: TeloStatus, host: TeloStatusHost): TeloStatusText {
  const pinned = status.pinned ? " (pinned)" : "";
  const label = status.version === undefined ? `Telo${pinned}` : `Telo ${describeEngineVersion(status.version)}${pinned}`;
  if (status.error) return { label, detail: status.error.message };
  const version = status.version === undefined ? "the telo engine" : `Telo ${describeEngineVersion(status.version)}`;
  if (status.starting) return { label: `${label} (starting)`, detail: `${version} is starting.` };
  const reason = status.reason;
  switch (reason?.kind) {
    case "pinned":
      return { label, detail: `${version}: pinned by ${host.setting}.` };
    case "owner-range":
      return {
        label,
        detail: `${version}: the lowest version accepted by this module's requires: telo: ${reason.range} and its imports' ranges.`,
      };
    case "closure-range":
      return {
        label,
        detail: `${version}: the lowest version accepted by the imports' requires: telo: ranges (${reason.ranges.join("; ")}).`,
      };
    case "unsatisfiable":
      return { label, detail: `${version}: no available telo satisfies ${reason.ranges.join("; ")}.` };
    default:
      return {
        label,
        detail: `${version}: the version bundled with ${host.product} — nothing in this module's imports asks for another.`,
      };
  }
}

/** One picker row: the version, and whether it is bundled, cached, and
 *  accepted by the active module's `requires: telo:` ranges. */
export function describeVersionMark(mark: MarkedVersion): TeloStatusText {
  const detail = [
    mark.bundled ? "bundled" : undefined,
    mark.cached ? "cached" : "not cached",
    mark.accepted === undefined
      ? undefined
      : mark.accepted
        ? "accepted by this module"
        : "refused by this module's requires: telo:",
  ]
    .filter(Boolean)
    .join(" · ");
  return { label: describeEngineVersion(mark.version), detail };
}

/** The picker's Auto row: what Auto resolves to for the active module, in the
 *  words the other rows use. */
export function describeAutoMark(marks: VersionMarks): TeloStatusText {
  return { label: "Auto", detail: marks.auto === undefined ? "" : `resolves to ${describeEngineVersion(marks.auto)}` };
}
