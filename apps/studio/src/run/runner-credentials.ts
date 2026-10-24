/**
 * The one seam every request to a session's runner is authorized through.
 *
 * A session is owned by a credential, and a request carries it as headers the
 * runner reads: the resume secret a create answered, as
 * `Authorization: Bearer <secret>`, or an identity — a DPoP-bound access token
 * and a proof signed per request (`identity-credentials.ts`), which is why the
 * headers are asked per request with the method and URL a proof names.
 *
 * The secret is held in a closure and never rendered: no message, log line or
 * stored status carries it.
 */
export interface RunnerCredentials {
  /** The headers authorizing one request. Asked again for every attempt, so
   *  each carries a fresh proof. */
  headers(request: { method: string; url: string }): Promise<Record<string, string>>;
  /** Whether a request the runner refused is worth one more attempt with new
   *  headers (an expired access token, renewed). Absent: never. */
  retry?(response: Response): Promise<boolean>;
}

export function resumeSecretCredentials(secret: string): RunnerCredentials {
  const authorization = `Bearer ${secret}`;
  return {
    headers: async () => ({ authorization }),
  };
}

/** Which workspace's secret, on which runner: a secret opens one session on
 *  one runner. */
export interface ResumeSecretScope {
  runner: string;
  workspaceKey: string;
}

/**
 * Where a workspace's resume secret is kept between page loads. The web build
 * keeps it inside the workspace's session entry in `localStorage`; the desktop
 * build in the OS credential store, through the shell.
 */
export interface ResumeSecretStore {
  read(scope: ResumeSecretScope): Promise<string | null>;
  write(scope: ResumeSecretScope, secret: string | null): Promise<void>;
}
