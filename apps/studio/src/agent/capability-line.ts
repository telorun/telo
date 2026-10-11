import type { AgentIdentityState } from "./types";

/** What the agent says it may do, from its capability document alone. Null when
 *  the document is unknown or states neither fact. */
export function capabilityLine(identity: AgentIdentityState | null): string | null {
  if (identity?.state !== "known") return null;
  const { manifestRuns, auth } = identity.identity;
  const claims: string[] = [];
  if (manifestRuns === true) claims.push("can run manifests and their tests");
  if (manifestRuns === false) claims.push("cannot run manifests or their tests");
  if (auth === "none") claims.push("accepts requests without a token");
  return claims.length === 0 ? null : `This agent ${claims.join(", and ")}.`;
}
