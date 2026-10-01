import { History, Square } from "lucide-react";
import * as React from "react";

import { reviewApi, type RunnerSession } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthor } from "@/lib/author-name";
import { formatTimestamp } from "@/lib/time-format";
import { AppLink, paths } from "@/routing";

function SessionRow({ session, onStop }: { session: RunnerSession; onStop?: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm">
      <span className="font-mono break-all">{session.id}</span>
      <span className="text-muted-foreground">{session.repo}</span>
      <span className="text-xs text-muted-foreground">
        seen {formatTimestamp(session.lastSeenAt ?? session.firstSeenAt)}
      </span>
      {session.plans.map((plan) => (
        <AppLink key={plan} href={paths.plan(plan)} className="text-xs hover:underline">
          plan {plan.slice(0, 8)}
        </AppLink>
      ))}
      {onStop && (
        <Button variant="destructive" size="sm" className="ml-auto" onClick={onStop}>
          <Square />
          Stop
        </Button>
      )}
    </li>
  );
}

function SessionGroup({ label, sessions, onStop }: { label: string; sessions: RunnerSession[]; onStop?: (id: string) => void }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{label}</h3>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} onStop={onStop ? () => onStop(session.id) : undefined} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The runner's sessions by state: the active ones, each stoppable, and the
 *  inactive ones newest first — a window that "Load older" extends. */
export function SessionsByState({
  runner,
  active,
  activeTruncated,
  inactive,
  inactiveExhausted,
  onLoadOlder,
  onQueued,
}: {
  runner: string;
  active: RunnerSession[];
  /** More active sessions exist than one page holds. */
  activeTruncated: boolean;
  inactive: RunnerSession[];
  inactiveExhausted: boolean;
  onLoadOlder: () => void;
  onQueued: () => void;
}) {
  const author = useAuthor();
  const [error, setError] = React.useState<unknown>(undefined);
  const [queued, setQueued] = React.useState<number | undefined>(undefined);

  const stop = async (session: string) => {
    if (!author) return;
    setError(undefined);
    setQueued(undefined);
    try {
      const { seq } = await reviewApi.stopSession(runner, { author, session });
      setQueued(seq);
      onQueued();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!author && <p className="text-xs text-muted-foreground">Enter your name at the top to stop a session.</p>}
        {queued !== undefined && <p className="text-sm">Stop queued as command #{queued}.</p>}
        {error !== undefined && <ErrorNotice error={error} />}
        <SessionGroup
          label={activeTruncated ? `Active (the newest ${active.length})` : `Active (${active.length})`}
          sessions={active}
          onStop={author ? stop : undefined}
        />
        <SessionGroup label="Inactive, newest first" sessions={inactive} />
        {!inactiveExhausted && (
          <Button variant="outline" size="sm" className="self-start" onClick={onLoadOlder}>
            <History />
            Load older
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
