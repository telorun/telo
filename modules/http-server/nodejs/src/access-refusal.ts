import { InvokeError, type TextRecord } from "@telorun/sdk";

/** One `WWW-Authenticate` challenge. */
export interface Challenge {
  readonly scheme: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export const ERR_HTTP_UNAUTHENTICATED = "ERR_HTTP_UNAUTHENTICATED";
export const ERR_HTTP_FORBIDDEN = "ERR_HTTP_FORBIDDEN";
export const ERR_HTTP_CROSS_ORIGIN_REFUSED = "ERR_HTTP_CROSS_ORIGIN_REFUSED";
export const ERR_HTTP_ACCESS_CHECK_UNAVAILABLE = "ERR_HTTP_ACCESS_CHECK_UNAVAILABLE";

/** The status each access refusal is answered with when no catch entry claims it. */
const STATUSES: Readonly<Record<string, number>> = {
  [ERR_HTTP_UNAUTHENTICATED]: 401,
  [ERR_HTTP_FORBIDDEN]: 403,
  [ERR_HTTP_CROSS_ORIGIN_REFUSED]: 403,
  [ERR_HTTP_ACCESS_CHECK_UNAVAILABLE]: 503,
};

/** A refusal the server raised itself, with the `WWW-Authenticate` value it answers with. */
interface AccessRefusal {
  readonly status: number;
  readonly wwwAuthenticate?: string;
}

const refusals = new WeakMap<InvokeError, AccessRefusal>();

/** Creates one of the four refusals; `displayMessage` is the server's declared text. */
export function accessRefusal(
  code: string,
  message: string,
  options: {
    data?: Record<string, unknown>;
    displayMessage?: TextRecord;
    cause?: unknown;
    challenges?: readonly Challenge[];
  } = {},
): InvokeError {
  const error = new InvokeError(code, message, options.data, {
    ...(options.displayMessage ? { displayMessage: options.displayMessage } : {}),
    ...("cause" in options ? { cause: options.cause } : {}),
  });
  const header = options.challenges && options.challenges.length > 0 ? challengeHeader(options.challenges) : undefined;
  refusals.set(error, { status: STATUSES[code]!, ...(header ? { wwwAuthenticate: header } : {}) });
  return error;
}

/** How the server answers `error` by default, when it raised it itself. */
export function accessRefusalOf(error: unknown): AccessRefusal | undefined {
  return error instanceof InvokeError ? refusals.get(error) : undefined;
}

/**
 * Challenges as one `WWW-Authenticate` value (RFC 9110 §11.6.1): comma-separated,
 * each `Scheme k="v", …` with every value quoted.
 */
export function challengeHeader(challenges: readonly Challenge[]): string {
  return challenges
    .map(({ scheme, parameters }) => {
      const rendered = Object.entries(parameters).map(([key, value]) => `${key}=${quoted(value)}`);
      return rendered.length === 0 ? scheme : `${scheme} ${rendered.join(", ")}`;
    })
    .join(", ");
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** `challenges` with identical entries dropped; schemes compare case-insensitively. */
export function distinctChallenges(challenges: readonly Challenge[]): Challenge[] {
  const seen = new Set<string>();
  return challenges.filter((challenge) => {
    const key = JSON.stringify([challenge.scheme.toLowerCase(), Object.entries(challenge.parameters).sort()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
