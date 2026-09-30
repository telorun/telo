import type { Route } from "./+types/robots";
import { hubContext } from "@/hub-context.server";

export function loader({ context }: Route.LoaderArgs) {
  const { siteOrigin } = context.get(hubContext).settings;
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
