import type { Route } from "./+types/sitemap-index";
import { hubContext } from "@/hub-context.server";
import { sitemapIndex } from "@/sitemap.server";

export function loader({ context }: Route.LoaderArgs) {
  const { hub, settings } = context.get(hubContext);
  return sitemapIndex(hub, settings.siteOrigin);
}
