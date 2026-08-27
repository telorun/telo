import { useEffect, useState } from "react";

/** Wall-clock age of a live run, ticking once a second. Null when nothing is
 *  live — a finished run is described by its status and start time, and a
 *  duration for it would need an end timestamp the record does not carry. */
export function useElapsed(startedAt: number | null): string | null {
  const live = startedAt !== null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, startedAt]);

  if (startedAt === null) return null;
  return formatDuration(Math.max(0, now - startedAt));
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}
