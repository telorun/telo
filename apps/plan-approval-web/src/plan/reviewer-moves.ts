import type { Decision, PlanState } from "@/api/review-api";

const ALLOWED_FROM: Record<Decision, readonly PlanState[]> = {
  approve: ["submitted", "revised", "changes_requested"],
  request_changes: ["submitted", "revised", "changes_requested", "approved", "in_progress", "parked"],
  reject: ["submitted", "revised", "changes_requested", "approved", "in_progress", "parked"],
};

/** The decisions the server accepts from a plan's state, in display order. */
export function legalDecisions(state: PlanState): Decision[] {
  return (["approve", "request_changes", "reject"] as const).filter((d) => ALLOWED_FROM[d].includes(state));
}
