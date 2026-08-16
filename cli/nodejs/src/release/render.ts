/**
 * Rendering a release plan for a person.
 *
 * The output's job is to answer "why is this module in the list", because that
 * is the question every previous version of this system could not answer. A
 * payload that moved through an inlined sibling, through an import whose version
 * is about to change, or through nothing anyone can name are three different
 * situations, and only the last one is a judgement call the reader has to make.
 */

import type { BumpReason, PlannedModule, ReleasePlan } from "@telorun/analyzer";
import type { Logger } from "../logger.js";

/** How many inlined files to name before summarizing. One is the common case
 *  and reads well; twenty would bury the module list. */
const MAX_NAMED_FILES = 2;

export function describeReason(reason: BumpReason): string {
  switch (reason.kind) {
    case "declared":
      return "declared";
    case "imports":
      return `imports ${reason.module}`;
    case "inlines": {
      const shown = reason.files.slice(0, MAX_NAMED_FILES).join(", ");
      const rest = reason.files.length - MAX_NAMED_FILES;
      return `inlines ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
    }
    case "unattributed":
      return "payload changed, unattributed";
  }
}

/**
 * The reason column: kinds in a fixed order so two runs read the same, a
 * declared fragment first because it is the one a human wrote, and repeats
 * collapsed — two fragments for one module are two changelog lines but one
 * reason, and printing `declared; declared` says nothing the count does not.
 */
function describeReasons(module: PlannedModule): string {
  const order: BumpReason["kind"][] = ["declared", "inlines", "imports", "unattributed"];
  const sorted = [...module.reasons].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  return [...new Set(sorted.map(describeReason))].join("; ");
}

export function renderPlan(plan: ReleasePlan, log: Logger): string[] {
  if (plan.modules.length === 0) return ["Nothing to release — every module matches the ledger."];

  const keyWidth = Math.max(...plan.modules.map((module) => module.key.length));
  const moveWidth = Math.max(
    ...plan.modules.map((module) => `${module.from} → ${module.to}`.length),
  );

  return plan.modules.map((module) => {
    const move = `${module.from} → ${module.to}`;
    return (
      `${module.key.padEnd(keyWidth)}  ${move.padEnd(moveWidth)}  ` +
      `${log.dim(`${module.level} — ${describeReasons(module)}`)}`
    );
  });
}

export function renderDiagnostics(plan: ReleasePlan, log: Logger): string[] {
  return plan.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.severity === "error" ? log.err.error("error") : log.err.warn("warning")}  ` +
      `${diagnostic.message}`,
  );
}

/** The machine surface: the same plan, without the column alignment. */
export function planPayload(plan: ReleasePlan): unknown {
  return {
    modules: plan.modules.map((module) => ({
      key: module.key,
      name: module.name,
      from: module.from,
      to: module.to,
      level: module.level,
      reasons: module.reasons.map(describeReason),
      changedLayers: module.changed.map((change) => change.layer),
      entries: module.entries.map((entry) => ({ kind: entry.kind, body: entry.body })),
    })),
    fragments: plan.fragments,
    diagnostics: plan.diagnostics,
  };
}
