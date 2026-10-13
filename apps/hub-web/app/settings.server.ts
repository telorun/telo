/** The server's settings, read from the environment once, when this module is
 *  first imported. `server.mjs` imports the server build (which imports this)
 *  before it listens, so a missing or malformed setting stops the process at
 *  start with the variable named, rather than failing the first request. */
export interface Settings {
  /** Where the server reads the hub (`/module`, `/modules`). */
  hubApiOrigin: string;
  /** Where the reader's browser calls the hub (search, categories, register). */
  browserApiOrigin: string;
  /** This site's own origin: canonicals, the sitemap and robots.txt. Never
   *  derived from `Host`, which the client controls. */
  siteOrigin: string;
  /** The identity provider readers sign in through, and this site's client id
   *  there. Null on a site that offers no sign-in. */
  oidc: { issuer: string; clientId: string } | null;
  /** The Plausible script every page loads. Null on a site that reports to no
   *  one. */
  plausibleScriptUrl: string | null;
  port: number;
}

/** Named so `server.mjs` can print just the message: the variable is the whole
 *  story, and a stack trace into the bundle would bury it. */
class SettingsError extends Error {
  override name = "SettingsError";
}

function origin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(`${name} must be an absolute http(s) origin, got "${value}"`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new SettingsError(
      `${name} must be a bare http(s) origin such as https://hub.telo.run, got "${value}"`,
    );
  }
  return url.origin;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new SettingsError(`${name} is required`);
  return origin(name, value);
}

function port(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8050;
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || parsed > 65535) {
    throw new SettingsError(`PORT must be an integer from 0 to 65535, got "${value}"`);
  }
  return parsed;
}

function oidc(env: NodeJS.ProcessEnv): Settings["oidc"] {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!issuer && !clientId) return null;
  if (!issuer) throw new SettingsError("OIDC_ISSUER is required when OIDC_CLIENT_ID is set");
  if (!clientId) throw new SettingsError("OIDC_CLIENT_ID is required when OIDC_ISSUER is set");
  return { issuer: origin("OIDC_ISSUER", issuer), clientId };
}

function scriptUrl(name: string, value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SettingsError(`${name} must be an absolute http(s) URL, got "${text}"`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SettingsError(`${name} must be an http(s) URL without credentials, got "${text}"`);
  }
  return url.href;
}

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const hubApiOrigin = required(env, "HUB_API_ORIGIN");
  const browser = env.HUB_BROWSER_API_ORIGIN?.trim();
  return {
    hubApiOrigin,
    browserApiOrigin: browser ? origin("HUB_BROWSER_API_ORIGIN", browser) : hubApiOrigin,
    siteOrigin: required(env, "SITE_ORIGIN"),
    oidc: oidc(env),
    plausibleScriptUrl: scriptUrl("PLAUSIBLE_SCRIPT_URL", env.PLAUSIBLE_SCRIPT_URL),
    port: port(env.PORT),
  };
}

export const settings: Settings = readSettings(process.env);
