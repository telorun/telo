import type { Route } from "./+types/sitemap-shard";
import { hubContext } from "@/hub-context.server";
import { PAGES_SITEMAP, SHARD_SIZE, sitemapPages, sitemapShard } from "@/sitemap.server";

export function loader({ context, params }: Route.LoaderArgs) {
  if (params.file === PAGES_SITEMAP) {
    const { hub, settings } = context.get(hubContext);
    return sitemapPages(hub, settings.siteOrigin);
  }
  const match = /^modules-(0|[1-9]\d*)\.xml$/.exec(params.file);
  const shard = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger((shard + 1) * SHARD_SIZE)) {
    throw new Response(null, { status: 404 });
  }
  const { hub, settings } = context.get(hubContext);
  return sitemapShard(hub, settings.siteOrigin, shard);
}
