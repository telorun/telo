/**
 * Why a unit moves, worded for a person: one phrase per reason, and a unit's
 * reasons in one line — what the text output and the markdown document show.
 */

import type { BumpReason, PlannedUnit } from "./release-plan.js";

const MAX_NAMED_FILES = 2;

/** How a unit key, group or file name is written into a reason. */
export type OperandFormat = (operand: string) => string;

const plainOperand: OperandFormat = (operand) => operand;

export function describeReason(reason: BumpReason): string {
  return describeReasonWith(reason, plainOperand);
}

export function describeReasonWith(reason: BumpReason, operand: OperandFormat): string {
  switch (reason.kind) {
    case "declared":
      return "declared";
    case "imports":
      return `imports ${operand(reason.unit)}`;
    case "version-location":
      return `holds the version of ${operand(reason.unit)}`;
    case "group":
      return `group ${operand(reason.group)}`;
    case "inlines": {
      const shown = reason.files.slice(0, MAX_NAMED_FILES).map((file) => operand(file)).join(", ");
      const rest = reason.files.length - MAX_NAMED_FILES;
      return `inlines ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
    }
    case "unattributed":
      return "payload changed, unattributed";
  }
}

const ORDER: BumpReason["kind"][] = ["declared", "inlines", "imports", "version-location", "group", "unattributed"];

/** A unit's reasons by kind, each phrase once, joined with `; `. */
export function describeReasons(unit: Pick<PlannedUnit, "reasons">): string {
  return describeReasonsWith(unit, plainOperand);
}

export function describeReasonsWith(unit: Pick<PlannedUnit, "reasons">, operand: OperandFormat): string {
  const sorted = [...unit.reasons].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return [...new Set(sorted.map((reason) => describeReasonWith(reason, operand)))].join("; ");
}
