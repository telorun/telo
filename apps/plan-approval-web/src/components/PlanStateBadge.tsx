import type { PlanState } from "@/api/review-api";
import { Badge } from "@/components/ui/badge";

const VARIANT: Record<PlanState, "default" | "secondary" | "destructive" | "outline"> = {
  submitted: "default",
  revised: "default",
  changes_requested: "secondary",
  approved: "outline",
  in_progress: "outline",
  parked: "secondary",
  completed: "secondary",
  rejected: "destructive",
  withdrawn: "secondary",
};

export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

export function PlanStateBadge({ state }: { state: PlanState }) {
  return <Badge variant={VARIANT[state]}>{stateLabel(state)}</Badge>;
}

export function OverdueBadge() {
  return <Badge variant="destructive">overdue</Badge>;
}
