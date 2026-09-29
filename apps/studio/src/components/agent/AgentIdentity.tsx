import { FlaskConicalOff, ShieldOff } from "lucide-react";
import { unsupportedFeatures, type AgentIdentityState } from "@/agent";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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

/** Shown while the agent reports it may not run manifests. An agent that does
 *  not say is not badged. */
export function NoTestRunsBadge({ identity }: { identity: AgentIdentityState | null }) {
  if (identity?.state !== "known" || identity.identity.manifestRuns !== false) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary">
            <FlaskConicalOff />
            No test runs
          </Badge>
        </TooltipTrigger>
        <TooltipContent>The agent can check manifests but not run them or their tests.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** What this agent does not offer, once it has been asked. */
export function UnsupportedFeatures({ identity }: { identity: AgentIdentityState | null }) {
  if (identity === null) return null;
  const missing = unsupportedFeatures(identity);
  if (missing.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground">
      Not supported by this agent:
      <ul className="list-disc pl-4">
        {missing.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    </div>
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
      const { name, version, promptId, manifestRuns } = identity.identity;
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
          {manifestRuns !== undefined && (
            <>
              <dt className="text-muted-foreground">Runs manifests</dt>
              <dd>{manifestRuns ? "yes" : "no"}</dd>
            </>
          )}
        </dl>
      );
    }
  }
}
