import type { Host } from "./host.js";
import type { SpecNode } from "./nodes.js";
import type { TranslatedText } from "./texts.js";
import { errorSpec, networkError, responseError } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

/** A page document: what a declared page draws. */
export interface PageDocument {
  bundle: string;
  digest: string;
  path: string;
  /** Absent for a page with no title: no heading is drawn. */
  title?: TranslatedText;
  lang?: string;
  /** The query parameters the page's nodes read, by name. */
  query?: Record<string, JsonSchema>;
  /** How wide its content is drawn, filled by the server. */
  width: "contained" | "full";
  children: SpecNode[];
}

/** Fetch a document, conditionally when one is already held: an unchanged
 *  one comes back as the one in hand. */
export async function fetchDocument<T extends { digest: string }>(host: Host, url: string, holding?: T): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (holding) headers["if-none-match"] = `"${holding.digest}"`;
  const response = await host.fetch(url, { headers }).catch((error) => {
    throw networkError(error);
  });
  if (response.status === 304 && holding) return holding;
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

/** The not-found nodes the server answers an undeclared path with: none when it sends none. */
export async function fetchNotFound(host: Host, url: string): Promise<SpecNode[] | undefined> {
  const response = await host.fetch(url, { headers: { accept: "application/json" } }).catch((error) => {
    throw networkError(error);
  });
  if (response.status !== 404) {
    if (!response.ok) throw await responseError(response);
    throw errorSpec(new Error(`The server answered a page for '${new URL(url, window.location.href).searchParams.get("path")}', which the application does not declare.`), "ERR_UI_REQUEST_FAILED");
  }
  const body = (await response.json().catch(() => undefined)) as { children?: SpecNode[] } | undefined;
  return body?.children;
}
