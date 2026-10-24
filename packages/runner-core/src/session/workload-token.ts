import type { WorkloadTokens } from "../backend.js";
import type { RunStatus } from "../contract.js";
import { randomBase32 } from "./session-id.js";

/** 32 × 5 bits = 160 bits: a credential, unlike a session id, must not be
 *  guessable, so it is the session-id generator at a credential's length. */
const WORKLOAD_TOKEN_LENGTH = 32;

/** Mints the token an agent declaring `tokenEnv` receives per workload. */
export function generateWorkloadToken(): string {
  return randomBase32(WORKLOAD_TOKEN_LENGTH);
}

/** A `running` status with the agent's token on its `agent` endpoint. */
export function statusWithTokens(status: RunStatus, tokens: WorkloadTokens | undefined): RunStatus {
  if (status.kind !== "running" || !status.agent || tokens?.agent === undefined) return status;
  return { ...status, agent: { ...status.agent, token: tokens.agent } };
}
