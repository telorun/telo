import { ShieldOff } from "lucide-react";
import type { AgentIdentityState } from "@/agent";
import { Badge } from "@/components/ui/badge";

/** Shown on the panel while the agent it talks to accepts requests without a
 *  token. An agent that does not report its auth mode shows nothing. */
export function NoAuthBadge({ identity }: { identity: AgentIdentityState | null }) {
  if (identity?.state !== "known" || identity.identity.auth !== "none") return null;
  return (
    <Badge variant="destructive" title="This agent accepts every request without a token.">
      <ShieldOff />
      No auth
    </Badge>
  );
}

/** Who the agent is, as it reports itself — read-only. */
export function AgentIdentityDetails({ identity }: { identity: AgentIdentityState | null }) {
  if (identity === null) {
    return <p className="text-xs text-muted-foreground">Agent identity not known yet.</p>;
  }
  switch (identity.state) {
    case "unavailable":
      return <p className="text-xs text-muted-foreground">Agent identity unavailable.</p>;
    case "unauthorized":
      return <p className="text-xs text-destructive">This agent requires a token.</p>;
    case "failed":
      return <p className="text-xs text-destructive">Could not ask the agent who it is: {identity.message}</p>;
    case "known": {
      const { name, version, promptId } = identity.identity;
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Agent</dt>
          <dd>{name}</dd>
          <dt className="text-muted-foreground">Version</dt>
          <dd>{version}</dd>
          <dt className="text-muted-foreground">Prompt</dt>
          <dd className="truncate font-mono" title={promptId}>
            {promptId}
          </dd>
        </dl>
      );
    }
  }
}
