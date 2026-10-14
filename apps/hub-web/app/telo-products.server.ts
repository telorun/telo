import type { TeloProduct } from "./ProductSwitcher";

/** The Telo product list accounts publishes at `/v1/products`, kept in
 *  process. Every entry is validated before it can reach CSS or an `<img src>`;
 *  a response that is not the documented shape is a failed fetch. A failed
 *  refresh keeps the last good list; with none ever fetched there is no list,
 *  and the header goes without its switcher. */

const FETCH_TIMEOUT_MS = 3_000;
const FRESH_FOR_MS = 5 * 60_000;

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const COLOR =
  /^oklch\((?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?) (?:0(?:\.\d{1,4})?) (?:\d{1,3}(?:\.\d{1,4})?)\)$/;

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? url : null;
}

/** Why an entry is refused, or null when it may be used. */
function rejection(entry: unknown, accountsOrigin: string, seen: Set<string>): string | null {
  if (typeof entry !== "object" || entry === null) return "not an object";
  const { id, name, url, icon, color } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id)) return "id does not match the product id pattern";
  if (seen.has(id)) return "id is listed twice";
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return "name is not 1-100 characters";
  }
  if (!httpsUrl(url)) return "url is not https";
  const iconUrl = httpsUrl(icon);
  if (!iconUrl) return "icon is not https";
  if (iconUrl.origin !== accountsOrigin) return "icon is not on the accounts origin";
  if (typeof color !== "object" || color === null) return "color is missing";
  const { light, dark } = color as Record<string, unknown>;
  if (typeof light !== "string" || !COLOR.test(light)) return "color.light is not an oklch colour";
  if (typeof dark !== "string" || !COLOR.test(dark)) return "color.dark is not an oklch colour";
  return null;
}

export interface ProductValidation {
  products: TeloProduct[];
  /** One line per refused entry: its position, its id when it has one, and why. */
  rejected: string[];
}

/** The usable entries of a `/v1/products` body, in its order. Throws when the
 *  body is not `{ products: [...] }`. */
export function validateProducts(body: unknown, accountsOrigin: string): ProductValidation {
  const list = (body as { products?: unknown } | null)?.products;
  if (typeof body !== "object" || body === null || !Array.isArray(list)) {
    throw new Error("the response is not { products: [...] }");
  }
  const products: TeloProduct[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, index) => {
    const reason = rejection(entry, accountsOrigin, seen);
    if (reason) {
      const id = (entry as { id?: unknown } | null)?.id;
      const label = typeof id === "string" ? ` (${JSON.stringify(id.slice(0, 64))})` : "";
      rejected.push(`entry ${index}${label}: ${reason}`);
      return;
    }
    const valid = entry as TeloProduct;
    seen.add(valid.id);
    products.push({
      id: valid.id,
      name: valid.name,
      url: new URL(valid.url).href,
      icon: new URL(valid.icon).href,
      color: { light: valid.color.light, dark: valid.color.dark },
    });
  });
  return { products, rejected };
}

export type ProductDirectory = ReturnType<typeof createProductDirectory>;

export interface ProductDirectoryOptions {
  accountsOrigin: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: (message: string) => void;
}

/** `list()` answers the current list, or null when none was ever fetched. It
 *  refreshes once the list is five minutes old: concurrent callers share one
 *  request, and a caller holding a list never waits for its refresh. A caller
 *  with no list waits for the request, which gives up after three seconds. */
export function createProductDirectory({
  accountsOrigin,
  fetch = globalThis.fetch,
  now = Date.now,
  log = (message) => console.error(message),
}: ProductDirectoryOptions) {
  const endpoint = `${accountsOrigin}/v1/products`;
  let current: TeloProduct[] | null = null;
  let fetchedAt = -Infinity;
  let inFlight: Promise<void> | null = null;
  // Logged once until they change, so a lasting fault is not repeated on
  // every refresh.
  let loggedRejections = "";
  let loggedFailure = "";

  async function load(): Promise<TeloProduct[]> {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`accounts answered ${response.status}`);
    }
    const { products, rejected } = validateProducts(await response.json(), accountsOrigin);
    const rejections = rejected.join("\n");
    if (rejections && rejections !== loggedRejections) {
      log(`hub-web: dropped Telo products from ${endpoint}:\n${rejections}`);
    }
    loggedRejections = rejections;
    return products;
  }

  function refresh(): Promise<void> {
    inFlight ??= load()
      .then(
        (products) => {
          current = products;
          fetchedAt = now();
          loggedFailure = "";
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== loggedFailure) {
            log(
              `hub-web: could not refresh the Telo products from ${endpoint} (${
                current ? "keeping the last list" : "no switcher until it answers"
              }): ${message}`,
            );
          }
          loggedFailure = message;
        },
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async list(): Promise<TeloProduct[] | null> {
      if (now() - fetchedAt < FRESH_FOR_MS) return current;
      const pending = refresh();
      if (!current) await pending;
      return current;
    },
  };
}
