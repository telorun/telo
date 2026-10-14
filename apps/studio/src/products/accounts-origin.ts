/**
 * Where accounts is, for reading the product list.
 *
 * The web build reads it at runtime from `/config.json`, which the image's
 * nginx writes from `ACCOUNTS_URL` — one image serves every environment. Where
 * that file is absent or unusable (`vite dev` answers every path with the
 * page), and always on the desktop, it is the build's `VITE_TELO_ACCOUNTS_URL`,
 * then the public accounts.
 */

export const DEFAULT_ACCOUNTS_ORIGIN = "https://accounts.telo.run";

/** The https origin `value` names, or null when it names anything else — a
 *  path, a query, another scheme, or not a URL at all. */
export function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

function buildTimeOrigin(envValue: string | undefined): string {
  if (envValue === undefined || envValue === "") return DEFAULT_ACCOUNTS_ORIGIN;
  const origin = httpsOrigin(envValue);
  if (!origin) {
    console.warn(`VITE_TELO_ACCOUNTS_URL is not an https origin: ${envValue}`);
    return DEFAULT_ACCOUNTS_ORIGIN;
  }
  return origin;
}

async function runtimeOrigin(fetchImpl: typeof fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl("/config.json", {
      credentials: "same-origin",
      cache: "no-cache",
      headers: { accept: "application/json" },
    });
  } catch (err) {
    console.warn("Studio's /config.json could not be read", err);
    return null;
  }
  // No runtime config on this origin (the dev server answers with the page).
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.warn("Studio's /config.json is not JSON", err);
    return null;
  }
  const accountsUrl =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).accountsUrl
      : undefined;
  const origin = httpsOrigin(accountsUrl);
  if (!origin) console.warn("Studio's /config.json names no https accounts origin");
  return origin;
}

export interface AccountsOriginEnvironment {
  desktop: boolean;
  fetch: typeof fetch;
  /** `import.meta.env.VITE_TELO_ACCOUNTS_URL`. */
  buildTimeAccountsUrl: string | undefined;
}

export async function resolveAccountsOrigin(env: AccountsOriginEnvironment): Promise<string> {
  if (!env.desktop) {
    const origin = await runtimeOrigin(env.fetch);
    if (origin) return origin;
  }
  return buildTimeOrigin(env.buildTimeAccountsUrl);
}
