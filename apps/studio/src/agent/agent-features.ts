import type { AgentIdentityState } from "./types";

/**
 * The optional surfaces an agent advertises in `GET /capabilities` `features`.
 * Every conversation and turn surface of the panel is gated on these, never on
 * the agent's version: an agent without the list — or without the route — is
 * talked to exactly as before they existed, and a missing entry hides only its
 * own surface.
 */
export const AGENT_FEATURES = {
  /** Agent-minted conversations: list, search, rename, archive, delete, export. */
  conversations: "conversations",
  /** Truncating a conversation from a turn: Retry, Edit & resend, Delete from here. */
  truncation: "conversation-truncation",
  /** Branching a new conversation from a turn. */
  branching: "conversation-branching",
  /** `changes` / `hunks` in the file tools' results, and a turn's net changes
   *  as diffs (`GET /chat/{turnId}/changes`). */
  turnChanges: "turn-changes",
  /** Putting back what a turn changed (`POST /chat/{turnId}/revert`). */
  turnRevert: "turn-revert",
  /** `summary` and `revert` on each ended turn of the records route. */
  turnSummary: "turn-summary",
  /** A spent step budget ends the turn in a wrap-up whose `finish` carries
   *  `limit: "max-steps"`, instead of failing it. */
  turnConclusion: "turn-conclusion",
} as const;

export type AgentFeature = (typeof AGENT_FEATURES)[keyof typeof AGENT_FEATURES];

const FEATURE_LABELS: Record<AgentFeature, string> = {
  conversations: "Conversation list, search and export",
  "conversation-truncation": "Retry, edit & resend, delete from here",
  "conversation-branching": "Branching a conversation",
  "turn-changes": "Diffs of what a turn changed",
  "turn-revert": "Reverting a turn's changes",
  "turn-summary": "A summary of each turn",
  "turn-conclusion": "Continuing after the step limit",
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
