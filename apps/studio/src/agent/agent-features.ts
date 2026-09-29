import type { AgentIdentityState } from "./types";

/**
 * The optional surfaces an agent advertises in `GET /capabilities` `features`.
 * Every conversation surface of the panel is gated on these, never on the
 * agent's version: an agent without the list — or without the route — is
 * talked to exactly as before conversations existed.
 */
export const AGENT_FEATURES = {
  /** Agent-minted conversations: list, search, rename, archive, delete, export. */
  conversations: "conversations",
  /** Truncating a conversation from a turn: Retry, Edit & resend, Delete from here. */
  truncation: "conversation-truncation",
  /** Branching a new conversation from a turn. */
  branching: "conversation-branching",
} as const;

export type AgentFeature = (typeof AGENT_FEATURES)[keyof typeof AGENT_FEATURES];

const FEATURE_LABELS: Record<AgentFeature, string> = {
  conversations: "Conversation list, search and export",
  "conversation-truncation": "Retry, edit & resend, delete from here",
  "conversation-branching": "Branching a conversation",
};

export function hasFeature(identity: AgentIdentityState | null, feature: AgentFeature): boolean {
  return identity?.state === "known" && (identity.identity.features ?? []).includes(feature);
}

/** What this agent does not offer, in the words the settings block shows —
 *  every feature when the agent could not be asked. */
export function unsupportedFeatures(identity: AgentIdentityState | null): string[] {
  return (Object.values(AGENT_FEATURES) as AgentFeature[])
    .filter((feature) => !hasFeature(identity, feature))
    .map((feature) => FEATURE_LABELS[feature]);
}
