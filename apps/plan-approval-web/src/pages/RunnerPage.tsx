import { RefreshCw } from "lucide-react";
import * as React from "react";

import { reviewApi, type RunnerCommand, type RunnerSession } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { formatAge, formatTimestamp } from "@/lib/time-format";
import { useLoad } from "@/lib/use-load";
import { CommandHistory } from "@/runners/CommandHistory";
import type { FetchWindowPage } from "@/runners/history-window";
import { SessionsByState } from "@/runners/SessionsByState";
import { StartSession } from "@/runners/StartSession";
import { useHistoryWindow } from "@/runners/use-history-window";

// Commands settle when the runner reports back, so the page re-reads what it
// shows on its own: the runner, its active sessions, and the two windows.
const REFRESH_MS = 5000;
const ACTIVE_PAGE = 500;

export function RunnerPage({ name }: { name: string }) {
  const [loaded, reload] = useLoad(async () => {
    const [{ runners }, active] = await Promise.all([
      reviewApi.listRunners(),
      reviewApi.runnerSessions(name, { state: "active", order: "desc", limit: ACTIVE_PAGE }),
    ]);
    return { runner: runners.find((r) => r.name === name), active: active.sessions };
  }, [name]);

  const fetchCommands = React.useCallback<FetchWindowPage<RunnerCommand>>(
    (page) => reviewApi.runnerCommands(name, page).then((r) => ({ items: r.commands, cursor: r.cursor })),
    [name],
  );
  const fetchInactive = React.useCallback<FetchWindowPage<RunnerSession>>(
    (page) =>
      reviewApi
        .runnerSessions(name, { ...page, state: "inactive" })
        .then((r) => ({ items: r.sessions, cursor: r.cursor })),
    [name],
  );
  const commands = useHistoryWindow(fetchCommands);
  const inactive = useHistoryWindow(fetchInactive);

  const refreshCommands = commands.refresh;
  const refreshInactive = inactive.refresh;
  const refresh = React.useCallback(() => {
    reload();
    refreshCommands();
    refreshInactive();
  }, [reload, refreshCommands, refreshInactive]);

  React.useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (loaded.status === "failed") return <ErrorNotice error={loaded.error} />;
  if (loaded.status === "loading") return <p className="text-sm text-muted-foreground">Loading runner…</p>;
  const { runner, active } = loaded.data;
  if (!runner) return <p className="text-sm text-muted-foreground">Runner {name} has never reported.</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{runner.name}</h1>
          <p className="text-sm text-muted-foreground" title={formatTimestamp(runner.lastSeenAt)}>
            Last seen {formatAge(runner.lastSeenAt)} · serves {runner.repos.join(", ") || "no repository"}
          </p>
        </div>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {inactive.error !== undefined && <ErrorNotice error={inactive.error} />}
      {commands.error !== undefined && <ErrorNotice error={commands.error} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <SessionsByState
          runner={runner.name}
          active={active}
          activeTruncated={active.length === ACTIVE_PAGE}
          inactive={inactive.view?.items ?? []}
          inactiveExhausted={inactive.view?.exhausted ?? true}
          onLoadOlder={inactive.loadOlder}
          onQueued={refresh}
        />
        <StartSession key={runner.repos.join(",")} runner={runner.name} repos={runner.repos} onQueued={refresh} />
      </div>
      <CommandHistory
        commands={commands.view?.items ?? []}
        exhausted={commands.view?.exhausted ?? true}
        onLoadOlder={commands.loadOlder}
      />
    </div>
  );
}
