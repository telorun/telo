import type { ModulePage } from "@/api";
import { publisherPath } from "@/catalog-filters";
import { moduleDisplayName } from "@/module-ref";
import shareImage from "@/telo-hub-share.png";

/** Where a page's head comes from, kept pure so the server render and a client
 *  navigation produce the same tags. */

export const SITE_NAME = "Telo Hub";

export const HOME_TITLE = "Telo Hub — find a module, on any host";
export const HOME_DESCRIPTION =
  "Federated discovery across every registered Telo module — search by what a resource does, on the HTTP registry, OCI registries, and direct manifest URLs.";

export const REGISTER_TITLE = `Register a module — ${SITE_NAME}`;
export const REGISTER_DESCRIPTION =
  "Add a module ref to the Telo Hub so its kinds become searchable across every host and transport.";

export const MCP_TITLE = `Connect over MCP — ${SITE_NAME}`;
export const MCP_DESCRIPTION =
  "Give an AI agent the Telo Hub over the Model Context Protocol: search modules by what they do, read kind schemas and pin versions, from any MCP client.";

export function categoryTitle(label: string): string {
  return `${label} modules — ${SITE_NAME}`;
}

export function categoryDescription(label: string, modules: number): string {
  return `${modules} Telo ${modules === 1 ? "module" : "modules"} in the ${label} category, across every registered host.`;
}

export function publisherTitle(publisher: string): string {
  return `Modules published on ${publisher} — ${SITE_NAME}`;
}

export function publisherDescription(publisher: string, modules: number): string {
  return `${modules} Telo ${modules === 1 ? "module" : "modules"} published on ${publisher}, indexed by the Telo Hub.`;
}

export function moduleTitle(page: ModulePage): string {
  return `${moduleDisplayName(page.module)} — ${SITE_NAME}`;
}

/** The module's own description, or — when it publishes none — one sentence
 *  from what the hub does know: the ref and the kinds it exports. */
export function moduleDescription(page: ModulePage): string {
  // Authored as a YAML block, so it arrives with its line breaks.
  const own = page.module.description?.replace(/\s+/g, " ").trim();
  if (own) return own;
  const kinds = page.kinds.map((k) => k.kind).filter(Boolean);
  const name = moduleDisplayName(page.module);
  return kinds.length > 0
    ? `${name} is a Telo module at ${page.module.ref} exporting ${kinds.join(", ")}.`
    : `${name} is a Telo module at ${page.module.ref}.`;
}

export function statusTitle(status: number): string {
  return `${status} — ${SITE_NAME}`;
}

export function canonicalLink(siteOrigin: string, path: string) {
  return { tagName: "link", rel: "canonical", href: `${siteOrigin}${path}` } as const;
}

/** What a pasted link unfurls as: the page's own title and description, under
 *  its canonical address. */
export function shareTags(siteOrigin: string, path: string, title: string, description: string) {
  return [
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: `${siteOrigin}${path}` },
    // The mark as a square PNG: link previews do not render SVG.
    { property: "og:image", content: `${siteOrigin}${shareImage}` },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:image", content: `${siteOrigin}${shareImage}` },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
}

/** A search-results address is not a page to index: the query space is
 *  unbounded and its rows are whatever matched. It tells crawlers so, and to
 *  keep following its links; it names no canonical, because it is not a
 *  duplicate of the page it was searched from. */
export const SEARCH_RESULTS_ROBOTS = { name: "robots", content: "noindex, follow" } as const;

/** The head of a catalogue page — home, a category, a publisher. Filters other
 *  than the query (a kernel, a type, an order) show a subset or a reordering of
 *  the same listing, so those addresses keep the listing's canonical. */
export function catalogueHead(
  siteOrigin: string,
  path: string,
  title: string,
  description: string,
  search: string,
) {
  const searching = Boolean(new URLSearchParams(search).get("q"));
  return [
    { title },
    { name: "description", content: description },
    ...(searching ? [SEARCH_RESULTS_ROBOTS] : [canonicalLink(siteOrigin, path)]),
    ...shareTags(siteOrigin, path, title, description),
  ];
}

/** Structured data: the site itself, for the home page. */
export function siteSchema(siteOrigin: string) {
  return {
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: `${siteOrigin}/`,
      description: HOME_DESCRIPTION,
    },
  };
}

/** Structured data for a module's page: where it sits, and what it is. Only
 *  what the hub actually knows is stated — no author, no date. */
export function moduleSchema(siteOrigin: string, page: ModulePage, pagePath: string) {
  const m = page.module;
  const name = moduleDisplayName(m);
  const trail = [
    { name: "Modules", item: `${siteOrigin}/` },
    ...(m.publisher
      ? [{ name: m.publisher, item: `${siteOrigin}${publisherPath(m.publisher)}` }]
      : []),
    { name, item: `${siteOrigin}${pagePath}` },
  ];
  return [
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: trail.map((crumb, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: crumb.name,
          item: crumb.item,
        })),
      },
    },
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name,
        description: moduleDescription(page),
        url: `${siteOrigin}${pagePath}`,
        identifier: m.ref,
        version: m.latestVersion || m.version,
        ...(m.repository ? { codeRepository: m.repository } : {}),
        ...(m.license ? { license: m.license } : {}),
        ...(m.runtime?.languages?.length ? { programmingLanguage: m.runtime.languages } : {}),
        ...(m.categories?.length ? { keywords: m.categories.map((c) => c.label).join(", ") } : {}),
      },
    },
  ];
}
