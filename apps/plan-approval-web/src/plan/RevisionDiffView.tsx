import * as React from "react";

import type { Revision } from "@/api/review-api";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/class-names";
import { itemSummary, lineDiff } from "@/plan/revision-diff";

function RevisionSelect({
  id,
  label,
  revisions,
  value,
  onChange,
}: {
  id: string;
  label: string;
  revisions: Revision[];
  value: number;
  onChange: (seq: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger id={id} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {revisions.map((revision) => (
            <SelectItem key={revision.seq} value={String(revision.seq)}>
              Revision {revision.seq} · {revision.hash.slice(0, 8)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function IdList({ label, ids, className }: { label: string; ids: string[]; className: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      {ids.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        ids.map((id) => (
          <Badge key={id} variant="outline" className={className}>
            {id}
          </Badge>
        ))
      )}
    </div>
  );
}

/** Any two revisions as a line diff plus the item IDs added, removed and changed.
 *  The base defaults to the last revision a reviewer commented on or decided. */
export function RevisionDiffView({
  revisions,
  lastReviewedRevision,
}: {
  revisions: Revision[];
  lastReviewedRevision: number;
}) {
  const latest = revisions[revisions.length - 1];
  const [baseSeq, setBaseSeq] = React.useState(lastReviewedRevision >= 1 ? lastReviewedRevision : revisions[0].seq);
  const [targetSeq, setTargetSeq] = React.useState(latest.seq);
  const base = revisions.find((r) => r.seq === baseSeq) ?? revisions[0];
  const target = revisions.find((r) => r.seq === targetSeq) ?? latest;

  const rows = React.useMemo(() => lineDiff(base.body, target.body), [base, target]);
  const summary = React.useMemo(() => itemSummary(base.body, target.body), [base, target]);
  const identical = rows.every((row) => row.kind === "same");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <RevisionSelect id="diff-base" label="Base" revisions={revisions} value={base.seq} onChange={setBaseSeq} />
        <RevisionSelect id="diff-target" label="Compared" revisions={revisions} value={target.seq} onChange={setTargetSeq} />
      </div>
      {lastReviewedRevision >= 1 && (
        <p className="text-xs text-muted-foreground">Last reviewed: revision {lastReviewedRevision}.</p>
      )}
      {target.summary && (
        <p className="text-sm">
          <span className="text-muted-foreground">Summary of revision {target.seq}: </span>
          {target.summary}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <IdList label="Added items" ids={summary.added} className="border-success text-success" />
        <IdList label="Removed items" ids={summary.removed} className="border-destructive text-destructive" />
        <IdList label="Changed items" ids={summary.changed} className="" />
      </div>
      {identical ? (
        <p className="text-sm text-muted-foreground">
          Revisions {base.seq} and {target.seq} have the same body.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border font-mono text-xs">
          {rows.map((row, index) => (
            <div
              key={index}
              className={cn(
                "grid grid-cols-[3rem_3rem_1.5rem_1fr]",
                row.kind === "added" && "bg-success/10",
                row.kind === "removed" && "bg-destructive/10",
              )}
            >
              <span className="px-1 text-right text-muted-foreground">{row.kind === "added" ? "" : row.baseLine}</span>
              <span className="px-1 text-right text-muted-foreground">{row.kind === "removed" ? "" : row.targetLine}</span>
              <span className="text-center">{row.kind === "added" ? "+" : row.kind === "removed" ? "-" : ""}</span>
              <span className="pr-2 whitespace-pre-wrap">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
