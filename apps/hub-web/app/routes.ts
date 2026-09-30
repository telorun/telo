import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("module/*", "routes/module.tsx"),
  route("sitemap.xml", "routes/sitemap-index.ts"),
  route("sitemaps/:file", "routes/sitemap-shard.ts"),
  route("robots.txt", "routes/robots.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
