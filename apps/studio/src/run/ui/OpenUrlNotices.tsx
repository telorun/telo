import { ExternalLink, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useRun } from "../context";

/** Open requests of this app's runs that are shown rather than asked: a run
 *  this page did not start, and an address no declared port answers. */
export function OpenUrlNotices({ appPath }: { appPath: string }) {
  const { openUrlRequests, answerOpenUrl } = useRun();
  const notices = openUrlRequests.filter((r) => r.mode === "notice" && r.appPath === appPath);
  if (notices.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col border-b border-zinc-200 dark:border-zinc-800">
      {notices.map((notice) => (
        <div key={notice.id} className="flex items-center gap-2 bg-zinc-50 px-3 py-1 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <ExternalLink size={13} className="shrink-0" aria-hidden />
          {notice.reach === "unrouted" ? (
            <span className="min-w-0 break-all">
              The app asked to open {notice.address}, a port this session does not route, so it is not opened.
            </span>
          ) : (
            <span className="min-w-0 break-all">
              The app asked to open{" "}
              <a href={notice.address} target="_blank" rel="noopener noreferrer" className="underline">
                {notice.address}
              </a>
              {notice.reach === "external" && <> (another site: {notice.host})</>}
            </span>
          )}
          <Button
            className="ml-auto"
            variant="ghost"
            size="icon-xs"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => answerOpenUrl(notice.id, { open: false })}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
}
