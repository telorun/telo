import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("category/:slug", "routes/category.tsx"),
  route("publisher/*", "routes/publisher.tsx"),
  route("register", "routes/register.tsx"),
  route("mcp", "routes/mcp.tsx"),
  route("auth/callback", "routes/auth-callback.tsx"),
  route("auth/silent", "routes/auth-silent.ts"),
  route("module/*", "routes/module.tsx"),
  route("sitemap.xml", "routes/sitemap-index.ts"),
  route("sitemaps/:file", "routes/sitemap-shard.ts"),
  route("robots.txt", "routes/robots.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
