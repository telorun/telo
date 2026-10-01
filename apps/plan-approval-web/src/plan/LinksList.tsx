import { ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";

import type { Link } from "@/api/review-api";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/time-format";

const ICON = {
  branch: <GitBranch className="size-4" />,
  "pull-request": <GitPullRequest className="size-4" />,
  commit: <GitCommitHorizontal className="size-4" />,
};

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/** The plan's branches, pull requests and commits with their last reported status. */
export function LinksList({ links }: { links: Link[] }) {
  if (links.length === 0) return <p className="text-sm text-muted-foreground">No links reported.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {links.map((link) => (
        <li key={`${link.type} ${link.url}`} className="flex flex-wrap items-center gap-2 text-sm">
          {ICON[link.type]}
          {isWebUrl(link.url) ? (
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 break-all hover:underline">
              {link.url}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="break-all">{link.url}</span>
          )}
          <Badge variant="outline">{link.status}</Badge>
          <span className="text-xs text-muted-foreground">reported {formatTimestamp(link.reportedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
