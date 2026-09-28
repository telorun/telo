import type { WorkloadTokens } from "../backend.js";
import type { RunnerEndpoint, RunStatus } from "../contract.js";
import { randomBase32 } from "./session-id.js";

/** 32 × 5 bits = 160 bits: a credential, unlike a session id, must not be
 *  guessable, so it is the session-id generator at a credential's length. */
const WORKLOAD_TOKEN_LENGTH = 32;

/** Mints the token a catalog entry declaring `tokenEnv` receives per session. */
export function generateWorkloadToken(): string {
  return randomBase32(WORKLOAD_TOKEN_LENGTH);
}

function withToken(endpoint: RunnerEndpoint, token: string | undefined): RunnerEndpoint {
  return token === undefined ? endpoint : { ...endpoint, token };
}

/** A `running` status with each minted token on the endpoints it belongs to. */
export function statusWithTokens(status: RunStatus, tokens: WorkloadTokens | undefined): RunStatus {
  if (!tokens || status.kind !== "running") return status;
  return {
    ...status,
    ...(status.endpoints
      ? { endpoints: status.endpoints.map((e) => withToken(e, tokens.endpoints)) }
      : {}),
    ...(status.agent ? { agent: withToken(status.agent, tokens.agent) } : {}),
  };
}

/** Endpoints an app gained on reload, carrying the application token. */
export function endpointsWithToken(
  endpoints: RunnerEndpoint[] | undefined,
  tokens: WorkloadTokens | undefined,
): RunnerEndpoint[] | undefined {
  return endpoints?.map((e) => withToken(e, tokens?.endpoints));
}
