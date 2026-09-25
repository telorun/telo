/** The document base URL rule, and resolving a URL against it. */

import { isHtmlElement, walkElements, type HtmlNode } from "./html-node.js";

function parseUrl(value: string, base?: string): string | undefined {
  try {
    return new URL(value, base).href;
  } catch {
    // Not a URL relative to this base — the caller keeps the value as written.
    return undefined;
  }
}

/**
 * The effective base: the first `<base href>` resolved against the page URL, or
 * the page URL when there is none. With no page URL, only an absolute `href`
 * gives one; nothing is inferred.
 */
export function effectiveBaseUrl(nodes: readonly HtmlNode[], pageUrl: string | undefined): string | undefined {
  for (const element of walkElements(nodes)) {
    if (!isHtmlElement(element, "base") || !("href" in element.attrs)) continue;
    return parseUrl(element.attrs.href!.trim(), pageUrl) ?? pageUrl;
  }
  return pageUrl;
}

/** `value` resolved against `base`; unchanged with no base or when it does not
 *  parse. */
export function resolveUrl(value: string, base: string | undefined): string {
  if (base === undefined) return value;
  return parseUrl(value.trim(), base) ?? value;
}
