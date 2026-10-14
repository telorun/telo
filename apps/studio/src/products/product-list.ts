/**
 * The Telo products accounts lists (`GET <accounts>/v1/products`), validated
 * before anything reaches CSS or an `<img src>`.
 */

export interface TeloProduct {
  id: string;
  /** The name after "Telo". */
  name: string;
  url: string;
  icon: string;
  color: { light: string; dark: string };
}

/** Studio's own id in the list. */
export const STUDIO_PRODUCT_ID = "studio";

const FETCH_TIMEOUT_MS = 3000;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const COLOR =
  /^oklch\((?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?) (?:0(?:\.\d{1,4})?) (?:\d{1,3}(?:\.\d{1,4})?)\)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Why an entry is dropped, or null when it is usable. */
function entryDefect(entry: unknown, accountsOrigin: string): string | null {
  if (!isRecord(entry)) return "not an object";
  const { id, name, url, icon, color } = entry;
  if (typeof id !== "string" || !ID.test(id)) return "invalid id";
  if (typeof name !== "string" || name.length < 1 || name.length > 100) return "invalid name";
  if (!httpsUrl(url)) return "url is not https";
  const iconUrl = httpsUrl(icon);
  if (!iconUrl) return "icon is not https";
  if (iconUrl.origin !== accountsOrigin) return "icon is not on the accounts origin";
  if (!isRecord(color)) return "no colours";
  if (typeof color.light !== "string" || !COLOR.test(color.light)) return "invalid light colour";
  if (typeof color.dark !== "string" || !COLOR.test(color.dark)) return "invalid dark colour";
  return null;
}

/**
 * The usable products of a `/v1/products` body, in its order. An invalid entry
 * is dropped and logged; a body that is not `{ products: [...] }` is a failure
 * (`null`).
 */
export function validateProducts(body: unknown, accountsOrigin: string): TeloProduct[] | null {
  if (!isRecord(body) || !Array.isArray(body.products)) return null;
  const products: TeloProduct[] = [];
  body.products.forEach((entry: unknown, index) => {
    const defect = entryDefect(entry, accountsOrigin);
    if (defect) {
      console.warn(`Telo products: entry ${index} dropped (${defect})`);
      return;
    }
    const valid = entry as unknown as TeloProduct;
    products.push({
      id: valid.id,
      name: valid.name,
      url: valid.url,
      icon: valid.icon,
      color: { light: valid.color.light, dark: valid.color.dark },
    });
  });
  return products;
}

/**
 * Fetches and validates the list from accounts, with a 3 s timeout. Any
 * failure — network, status, timeout, shape — is logged and answers `null`:
 * the top bar then shows no switcher.
 */
export async function fetchProducts(
  accountsOrigin: string,
  fetchImpl: typeof fetch,
): Promise<TeloProduct[] | null> {
  try {
    const response = await fetchImpl(`${accountsOrigin}/v1/products`, {
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`Telo products: ${accountsOrigin}/v1/products answered ${response.status}`);
      return null;
    }
    const products = validateProducts(await response.json(), accountsOrigin);
    if (!products) console.warn("Telo products: the response is not a product list");
    return products;
  } catch (err) {
    console.warn("Telo products: the list could not be read", err);
    return null;
  }
}

/** The style rules colouring each product's name, for both colour modes.
 *  Only validated values reach it. */
export function productColorRules(products: readonly TeloProduct[]): string {
  const light = products.map((p) => `--product-${p.id}:${p.color.light};`).join("");
  const dark = products.map((p) => `--product-${p.id}:${p.color.dark};`).join("");
  const names = products
    .map((p) => `.${productNameClass(p.id)}{color:var(--product-${p.id});}`)
    .join("");
  return `:root{${light}}.dark{${dark}}${names}`;
}

export function productNameClass(id: string): string {
  return `telo-product-${id}`;
}
