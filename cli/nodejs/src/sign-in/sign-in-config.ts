/** The accounts issuer the CLI signs in with; never derived from a runner. */
export const ACCOUNTS_URL_ENV = "TELO_ACCOUNTS_URL";
export const DEFAULT_ACCOUNTS_URL = "https://accounts.telo.run";

/** The Telo Cloud API, the grant's `cloud` resource. */
export const CLOUD_API_URL_ENV = "TELO_CLOUD_API_URL";
export const DEFAULT_CLOUD_API_URL = "https://console.telo.cloud/api";

/** The public native client accounts registers for the CLI. */
export const CLI_CLIENT_ID = "telo-cli";

/** Every scope `telo-cli` is registered for; `offline_access` is what makes the grant refreshable. */
export const CLI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "cloud:access",
  "cloud:projects.create",
  "cloud:projects.admin",
  "cloud:targets.manage",
  "cloud:billing.read",
  "cloud:audit.read",
  "runner:sessions",
] as const;

/** The DPoP algorithm telo signs proofs with. */
export const DPOP_ALGORITHM = "ES256";

export function resolveAccountsIssuer(env: NodeJS.ProcessEnv): string {
  return withoutTrailingSlashes(env[ACCOUNTS_URL_ENV]?.trim() || DEFAULT_ACCOUNTS_URL);
}

export function resolveCloudApiUrl(env: NodeJS.ProcessEnv): string {
  return withoutTrailingSlashes(env[CLOUD_API_URL_ENV]?.trim() || DEFAULT_CLOUD_API_URL);
}

/** `text` with every trailing `/` removed, in one pass (a regex backtracks on a long run of them). */
export function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) end--;
  return text.slice(0, end);
}
