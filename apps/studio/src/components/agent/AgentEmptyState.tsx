import { capabilityLine, type AgentIdentityState } from "@/agent";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { StarterPromptList } from "./StarterPromptList";

/** An empty conversation: starter prompts, and what the agent's capability
 *  document says it may do. A starter fills the composer; it is the user who
 *  sends it. */
export function AgentEmptyState({
  identity,
  onPick,
}: {
  identity: AgentIdentityState | null;
  onPick: (prompt: string) => void;
}) {
  const capability = capabilityLine(identity);
  return (
    <ConversationEmptyState>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Describe what you want to build</h3>
        {capability && <p className="text-sm text-muted-foreground">{capability}</p>}
      </div>
      <StarterPromptList onPick={onPick} />
    </ConversationEmptyState>
  );
}
