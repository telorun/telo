import { Check, MessageSquareWarning, X } from "lucide-react";
import * as React from "react";

import { reviewApi, type Decision, type Plan } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { stateLabel } from "@/components/PlanStateBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/lib/author-name";
import { legalDecisions } from "@/plan/reviewer-moves";

const LABEL: Record<Decision, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  reject: "Reject",
};

const ICON: Record<Decision, React.ReactNode> = {
  approve: <Check />,
  request_changes: <MessageSquareWarning />,
  reject: <X />,
};

/** Approve, request changes or reject, bound to the latest revision's seq and hash. */
export function DecisionPanel({ plan, onDecided }: { plan: Plan; onDecided: () => void }) {
  const author = useAuthor();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(undefined);
  const decisions = legalDecisions(plan.state);

  const decide = async (decision: Decision) => {
    if (!author) return;
    setBusy(true);
    setError(undefined);
    try {
      await reviewApi.decide(plan.id, {
        author,
        decision,
        revision: plan.latestRevision.seq,
        hash: plan.latestRevision.hash,
        ...(note.trim() === "" ? {} : { note }),
      });
      setNote("");
      onDecided();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision on revision {plan.latestRevision.seq}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decision is open while the plan is {stateLabel(plan.state)}.</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="decision-note">Note (required to request changes)</Label>
              <Textarea id="decision-note" value={note} maxLength={20000} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              {decisions.map((decision) => (
                <Button
                  key={decision}
                  variant={decision === "approve" ? "default" : decision === "reject" ? "destructive" : "secondary"}
                  disabled={busy || !author || (decision === "request_changes" && note.trim() === "")}
                  onClick={() => decide(decision)}
                >
                  {ICON[decision]}
                  {LABEL[decision]}
                </Button>
              ))}
            </div>
            {!author && <p className="text-xs text-muted-foreground">Enter your name at the top to decide.</p>}
          </>
        )}
        {error !== undefined && <ErrorNotice error={error} />}
      </CardContent>
    </Card>
  );
}
