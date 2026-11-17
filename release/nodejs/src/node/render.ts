/**
 * A release plan for a person: per unit, the move, the level, the cause and the
 * group — because "why is this unit in the list" is the question to answer.
 */

import { describeReason, describeReasons } from "../bump-reason-text.js";
import { NOTHING_TO_RELEASE } from "../plan-markdown.js";
import type { ReleaseDiagnostic, ReleasePlan } from "../release-plan.js";
import type { Style } from "./host.js";

export function renderPlan(plan: ReleasePlan, style: Style): string[] {
  if (plan.units.length === 0) return [NOTHING_TO_RELEASE];
  const keyWidth = Math.max(...plan.units.map((unit) => unit.key.length));
  const moveWidth = Math.max(...plan.units.map((unit) => `${unit.from} → ${unit.to}`.length));
  return plan.units.map((unit) => {
    const move = `${unit.from} → ${unit.to}`;
    const group = unit.group ? `  [${unit.group}]` : "";
    return `${unit.key.padEnd(keyWidth)}  ${move.padEnd(moveWidth)}  ${style.dim(`${unit.level} — ${describeReasons(unit)}`)}${group}`;
  });
}

export function renderDiagnostics(diagnostics: readonly ReleaseDiagnostic[], style: Style): string[] {
  return diagnostics.map(
    (diagnostic) =>
      `${diagnostic.severity === "error" ? style.error(diagnostic.code) : style.warn(diagnostic.code)}  ${diagnostic.message}`,
  );
}

/** The machine surface: the same plan, without the alignment. */
export function planPayload(plan: ReleasePlan): Record<string, unknown> {
  return {
    units: plan.units.map((unit) => ({
      key: unit.key,
      name: unit.name,
      from: unit.from,
      to: unit.to,
      tag: unit.tag,
      level: unit.level,
      ...(unit.group ? { group: unit.group } : {}),
      reasons: unit.reasons.map(describeReason),
      changedLayers: unit.changed.map((change) => change.path.join("/")),
      entries: unit.entries.map((entry) => ({ kind: entry.kind, body: entry.body })),
    })),
    fragments: plan.fragments,
    ...(plan.candidate ? { candidate: plan.candidate } : {}),
    diagnostics: plan.diagnostics,
  };
}
