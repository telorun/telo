import type { ModulePage } from "@/api";
import { moduleDisplayName } from "@/module-ref";

/** Where a page's head comes from, kept pure so the server render and a client
 *  navigation produce the same tags. */

export const SITE_NAME = "Telo Hub";

export const HOME_TITLE = "Telo Hub — find a module, on any host";
export const HOME_DESCRIPTION =
  "Federated discovery across every registered Telo module — search by what a resource does, on the HTTP registry, OCI registries, and direct manifest URLs.";

export function moduleTitle(page: ModulePage): string {
  return `${moduleDisplayName(page.module)} — ${SITE_NAME}`;
}

/** The module's own description, or — when it publishes none — one sentence
 *  from what the hub does know: the ref and the kinds it exports. */
export function moduleDescription(page: ModulePage): string {
  const own = page.module.description?.trim();
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
