/**
 * A CEL site's name: its UNION PLACE, never its expression object. The census
 * names each site by it and the door each occurrence it meets, so one place is
 * one name in both, and two places holding one expression object are two.
 *
 * Browser-safe.
 */
import { TEMPLATE_BODY_FIELDS } from "./template-expansion.js";

/** The declaration a finding about a site is reported against. */
export interface CelSiteHolder {
  readonly kind: unknown;
  readonly name: unknown;
  readonly source: unknown;
}

/** The name of the site at `written` — where its expression is written in
 *  `holder` — or, at a place with no written place in the holder's world (one
 *  a view's body wrote, which no forward moves), at `declared`, its
 *  declaration's own place: where placement reports a finding about it. */
export function celSiteName(holder: CelSiteHolder, written: string | undefined, declared: string): string {
  return celSiteId(holder.kind, holder.name, holder.source, written ?? declared);
}

/** A site's name as text: the written place a finding about it is reported
 *  at. */
export function celSiteId(kind: unknown, name: unknown, filePath: unknown, path: string): string {
  return JSON.stringify([kind, name, filePath, path]);
}

/** Whether `site` is a template body's expression. */
export function isBodySiteId(site: string): boolean {
  const [kind, , , path] = JSON.parse(site) as [unknown, unknown, unknown, string];
  return kind === "Telo.Definition" && TEMPLATE_BODY_FIELDS.includes(path.split(/[.[]/)[0]!);
}
