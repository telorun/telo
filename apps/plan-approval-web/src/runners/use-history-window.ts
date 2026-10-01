import * as React from "react";

import {
  loadOlder,
  openWindow,
  refreshWindow,
  type FetchWindowPage,
  type HistoryWindow,
} from "@/runners/history-window";

export interface HistoryWindowState<T> {
  view: HistoryWindow<T> | undefined;
  error: unknown;
  loadOlder: () => void;
  refresh: () => void;
}

/** A history window opened when `fetchPage` changes. Its reads run one at a
 *  time, each from the window the previous one left, so a refresh never undoes
 *  a "Load older". */
export function useHistoryWindow<T>(fetchPage: FetchWindowPage<T>): HistoryWindowState<T> {
  const [view, setView] = React.useState<HistoryWindow<T> | undefined>(undefined);
  const [error, setError] = React.useState<unknown>(undefined);
  const latest = React.useRef<HistoryWindow<T> | undefined>(undefined);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const generation = React.useRef(0);
  const refreshing = React.useRef(false);

  const enqueue = React.useCallback(
    (read: (current: HistoryWindow<T> | undefined) => Promise<HistoryWindow<T>>) => {
      const mine = generation.current;
      queue.current = queue.current.then(async () => {
        if (mine !== generation.current) return;
        try {
          const next = await read(latest.current);
          if (mine !== generation.current) return;
          latest.current = next;
          setView(next);
          setError(undefined);
        } catch (failure) {
          if (mine === generation.current) setError(failure);
        }
      });
    },
    [],
  );

  React.useEffect(() => {
    generation.current += 1;
    // A refresh queued for the previous list is dropped unrun.
    refreshing.current = false;
    latest.current = undefined;
    setView(undefined);
    setError(undefined);
    enqueue(() => openWindow(fetchPage));
  }, [fetchPage, enqueue]);

  return {
    view,
    error,
    loadOlder: React.useCallback(
      () => enqueue((current) => (current ? loadOlder(current, fetchPage) : openWindow(fetchPage))),
      [enqueue, fetchPage],
    ),
    // A refresh asked for while one is queued or running is skipped, not queued.
    refresh: React.useCallback(() => {
      if (refreshing.current) return;
      refreshing.current = true;
      enqueue(async (current) => {
        try {
          return await (current ? refreshWindow(current, fetchPage) : openWindow(fetchPage));
        } finally {
          refreshing.current = false;
        }
      });
    }, [enqueue, fetchPage]),
  };
}
