import { Download, MessageSquarePlus, RefreshCw } from "lucide-react";
import * as React from "react";

import { historyUrl, reviewApi, type PlanDetail } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { OverdueBadge, PlanStateBadge } from "@/components/PlanStateBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTimestamp } from "@/lib/time-format";
import { useLoad } from "@/lib/use-load";
import { CommentPanel } from "@/plan/CommentPanel";
import { DecisionPanel } from "@/plan/DecisionPanel";
import { LinksList } from "@/plan/LinksList";
import { PlanBody } from "@/plan/PlanBody";
import { RevisionDiffView } from "@/plan/RevisionDiffView";
import { Timeline } from "@/plan/Timeline";
import { AppLink, paths } from "@/routing";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function PlanView({ detail, reload }: { detail: PlanDetail; reload: () => void }) {
  const { plan, revisions, events, links, lastReviewedRevision } = detail;
  const latest = revisions[revisions.length - 1];
  const [commentItem, setCommentItem] = React.useState<string | undefined>(undefined);
  const commentRef = React.useRef<HTMLTextAreaElement>(null);

  const commentCounts = new Map<string, number>();
  for (const event of events) {
    const item = event.type === "comment" ? event.data.item : undefined;
    if (typeof item === "string" && item !== "") commentCounts.set(item, (commentCounts.get(item) ?? 0) + 1);
  }

  const commentOn = (id: string) => {
    setCommentItem(id);
    commentRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{plan.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <PlanStateBadge state={plan.state} />
            {plan.overdue && <OverdueBadge />}
            <span className="text-xs text-muted-foreground">
              revision {latest.seq} · {formatTimestamp(latest.createdAt)}
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={reload}>
          <RefreshCw />
          Refresh
        </Button>
        <Button variant="outline" asChild>
          <a href={historyUrl.plan(plan.id)} target="_blank" rel="noopener">
            <Download />
            History (JSON)
          </a>
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label="Product">{plan.product}</Fact>
        <Fact label="Repository">{plan.repo}</Fact>
        <Fact label="Branch">{plan.branch}</Fact>
        <Fact label="Loop">{plan.loop}</Fact>
        <Fact label="Session">
          <span className="font-mono">{plan.session ?? "none"}</span>
        </Fact>
        <Fact label="Runner">
          {plan.runner ? (
            <AppLink href={paths.runner(plan.runner)} className="hover:underline">
              {plan.runner}
            </AppLink>
          ) : (
            "none"
          )}
        </Fact>
        <Fact label="Approved">
          {plan.approvedSeq !== null ? `revision ${plan.approvedSeq} · ${plan.approvedHash?.slice(0, 12)}` : "no"}
        </Fact>
        <Fact label="Latest hash">
          <span className="font-mono">{latest.hash.slice(0, 12)}</span>
        </Fact>
      </dl>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Tabs defaultValue="plan">
          <TabsList>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="timeline">Timeline ({events.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="plan" className="pt-3">
            <PlanBody
              body={latest.body}
              items={latest.items}
              itemControl={(id) => (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="mr-1 align-middle"
                  title={`Comment on ${id}`}
                  aria-label={`Comment on ${id}`}
                  onClick={() => commentOn(id)}
                >
                  <MessageSquarePlus />
                  {commentCounts.get(id) ? <span className="text-[0.65rem]">{commentCounts.get(id)}</span> : null}
                </Button>
              )}
            />
          </TabsContent>
          <TabsContent value="diff" className="pt-3">
            <RevisionDiffView
              key={`${latest.seq}:${lastReviewedRevision}`}
              revisions={revisions}
              lastReviewedRevision={lastReviewedRevision}
            />
          </TabsContent>
          <TabsContent value="timeline" className="pt-3">
            <Timeline events={events} />
          </TabsContent>
        </Tabs>

        <div className="flex flex-col gap-4">
          <DecisionPanel plan={plan} onDecided={reload} />
          <CommentPanel
            planId={plan.id}
            revision={latest}
            item={commentItem}
            onItemChange={setCommentItem}
            onCommented={reload}
            textareaRef={commentRef}
          />
          <Card>
            <CardHeader>
              <CardTitle>Links</CardTitle>
            </CardHeader>
            <CardContent>
              <LinksList links={links} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function PlanPage({ id }: { id: string }) {
  const [detail, reload] = useLoad(() => reviewApi.planDetail(id), [id]);
  if (detail.status === "failed") return <ErrorNotice error={detail.error} />;
  if (detail.status === "loading") return <p className="text-sm text-muted-foreground">Loading plan…</p>;
  return <PlanView detail={detail.data} reload={reload} />;
}
