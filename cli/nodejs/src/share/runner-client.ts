import type {
  CreateShareRequest,
  RunnerCapabilities,
  RunnerError,
  Share,
  ShareList,
  SharesFeature,
} from "@telorun/runner-protocol";
import { runnerIdentityMismatch } from "../sign-in/runner-identity.js";
import type { SignInCredentialProvider } from "../sign-in/runner-sign-in.js";
import { ShareRefusal } from "./share-refusal.js";

/** The least lifetime a token must still have when a request is signed. */
const MIN_TOKEN_LIFETIME_MS = 30_000;

export interface RunnerClientOptions {
  /** The runner as the user named it, without a trailing slash. */
  runnerUrl: string;
  /** The accounts issuer the runner's advertised identity must name. */
  issuer: string;
  credentials: SignInCredentialProvider;
  fetch?: typeof fetch;
}

/** The runner's `/v1/capabilities`, which needs no credential. */
async function readCapabilities(options: RunnerClientOptions): Promise<RunnerCapabilities> {
  const response = await send(options, "GET", "/v1/capabilities", { headers: {} });
  if (!response.ok) throw await refusalOf(options.runnerUrl, response);
  return (await response.json()) as RunnerCapabilities;
}

/** The runner's share limits, or the refusal that it offers no shares or that its
 *  advertised identity disagrees with the configuration. Asked before any
 *  credential, so an unsupported runner is never asked to sign in and no token is
 *  sent to a runner that names another. */
export async function readSharesFeature(options: RunnerClientOptions): Promise<SharesFeature> {
  const { features, identity } = await readCapabilities(options);
  if (!features?.shares) {
    throw new ShareRefusal("ERR_SHARE_RUNNER_UNSUPPORTED", `${options.runnerUrl} offers no shares`);
  }
  const mismatch = runnerIdentityMismatch(options.runnerUrl, identity, options.issuer);
  if (mismatch !== undefined) throw new ShareRefusal("ERR_RUNNER_IDENTITY_MISMATCH", mismatch);
  return features.shares;
}

export async function createShare(options: RunnerClientOptions, request: CreateShareRequest): Promise<Share> {
  return (await authorized(options, "POST", "/v1/shares", request)) as Share;
}

export async function listShares(options: RunnerClientOptions): Promise<ShareList> {
  return (await authorized(options, "GET", "/v1/shares")) as ShareList;
}

export async function deleteShare(options: RunnerClientOptions, id: string): Promise<void> {
  await authorized(options, "DELETE", `/v1/shares/${encodeURIComponent(id)}`);
}

/** One request with a fresh DPoP proof, `htu` the URL it is sent to. */
async function authorized(
  options: RunnerClientOptions,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${options.runnerUrl}${pathname}`;
  const answer = await options.credentials.credential({
    runnerUrl: options.runnerUrl,
    minLifetimeMs: MIN_TOKEN_LIFETIME_MS,
    signal: new AbortController().signal,
  });
  if (answer.outcome === "sign-in-required") {
    throw new ShareRefusal(
      "ERR_RUNNER_SIGN_IN_REQUIRED",
      answer.message ?? `sharing needs a sign-in to ${answer.runnerUrl}`,
      [`run: ${answer.command}`],
    );
  }
  if (answer.outcome === "unavailable") throw new ShareRefusal(undefined, answer.message);
  const { credential } = answer;
  const proof = await credential.proof({ htm: method, htu: url });
  const response = await send(options, method, pathname, {
    headers: {
      authorization: `DPoP ${credential.accessToken}`,
      dpop: proof,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await refusalOf(options.runnerUrl, response);
  return response.status === 204 ? undefined : await response.json();
}

async function send(
  options: RunnerClientOptions,
  method: string,
  pathname: string,
  init: { headers: Record<string, string>; body?: string },
): Promise<Response> {
  const url = `${options.runnerUrl}${pathname}`;
  try {
    return await (options.fetch ?? fetch)(url, { method, ...init });
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new ShareRefusal(undefined, `could not reach ${url}: ${reason}`);
  }
}

/** The runner's own words for a refusal: its code and message. */
async function refusalOf(runnerUrl: string, response: Response): Promise<ShareRefusal> {
  let body: Partial<RunnerError> | undefined;
  try {
    body = (await response.json()) as Partial<RunnerError>;
  } catch {
    body = undefined;
  }
  if (typeof body?.error === "string" && typeof body.message === "string") {
    return new ShareRefusal(body.error, body.message);
  }
  return new ShareRefusal(undefined, `${runnerUrl} answered ${response.status} ${response.statusText}`.trimEnd());
}
