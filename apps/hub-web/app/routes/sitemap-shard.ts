import type { Route } from "./+types/sitemap-shard";
import { hubContext } from "@/hub-context.server";
import { SHARD_SIZE, sitemapShard } from "@/sitemap.server";

export function loader({ context, params }: Route.LoaderArgs) {
  const match = /^modules-(0|[1-9]\d*)\.xml$/.exec(params.file);
  const shard = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger((shard + 1) * SHARD_SIZE)) {
    throw new Response(null, { status: 404 });
  }
  const { hub, settings } = context.get(hubContext);
  return sitemapShard(hub, settings.siteOrigin, shard);
}
