import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { Catalog } from "@/Catalog";
import { catalogPath, readFilters } from "@/catalog-filters";
import { readCatalogSeed } from "@/catalog-seed.server";
import { hubContext } from "@/hub-context.server";
import { catalogueHead, HOME_DESCRIPTION, HOME_TITLE, siteSchema } from "@/module-head";

/** The catalogue is still usable when the hub does not answer the server: the
 *  page renders without a seed and the browser asks, and reports, itself. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // A category and a publisher each have a page of their own; as a query
  // parameter here either one is the same view under a second address.
  const category = url.searchParams.get("category") ?? "";
  const filters = readFilters(url.searchParams);
  if (category || filters.publisher) throw redirect(catalogPath(category, filters), 301);
  const { seed } = await readCatalogSeed(context.get(hubContext).hub, { category: "", publisher: "" });
  return seed;
}

/** The seed answers "everything, unfiltered", which a change of query string
 *  never invalidates — and re-reading it per keystroke would be a hub read per
 *  keystroke. */
export function shouldRevalidate() {
  return false;
}

export const meta: Route.MetaFunction = ({ matches, location }) => {
  const { siteOrigin } = matches[0].loaderData;
  return [
    ...catalogueHead(siteOrigin, "/", HOME_TITLE, HOME_DESCRIPTION, location.search),
    siteSchema(siteOrigin),
  ];
};

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <Catalog category="" publisher="" seed={loaderData} />;
}
