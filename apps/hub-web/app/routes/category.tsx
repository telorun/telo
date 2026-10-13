import { data, redirect, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/category";
import { Catalog } from "@/Catalog";
import { catalogPath } from "@/catalog-filters";
import { readCatalogSeed } from "@/catalog-seed.server";
import { hubContext } from "@/hub-context.server";
import { catalogueHead, categoryDescription, categoryTitle, statusTitle } from "@/module-head";
import { errorStatus, StatusPage } from "@/StatusPage";

/** One category's page. The hub's answer decides whether it exists: a slug no
 *  module declares is a 404, never an empty 200 a crawler would index. Unlike
 *  the home page this one has nothing to show without the hub, so a hub that
 *  does not answer is a 503.
 *
 *  A category has ONE address: the slug exactly as the hub's facet lists it.
 *  The hub itself is lenient — it reads `Storage` as `storage` — so without the
 *  exact match every spelling would be a second page with the same content. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const slug = params.slug;
  const url = new URL(request.url);
  if (url.pathname !== catalogPath(slug)) throw redirect(`${catalogPath(slug)}${url.search}`, 301);
  const { seed, absent } = await readCatalogSeed(context.get(hubContext).hub, {
    category: slug,
    publisher: "",
  });
  if (absent) throw data(null, { status: 404 });
  if (!seed.page || !seed.facets) throw new Response(null, { status: 503 });
  const facet = seed.facets.find((f) => f.category === slug);
  if (!facet) throw data(null, { status: 404 });
  return { slug, label: facet.label || slug, seed };
}

/** Re-read when the category changes, never for a change of query string. */
export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams.slug !== nextParams.slug;
}

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

export const meta: Route.MetaFunction = ({ loaderData, matches, error, location }) => {
  if (error || !loaderData) return [{ title: statusTitle(errorStatus(error)) }];
  const { siteOrigin } = matches[0].loaderData;
  const path = catalogPath(loaderData.slug);
  const title = categoryTitle(loaderData.label);
  const description = categoryDescription(loaderData.label, loaderData.seed.page?.total ?? 0);
  return catalogueHead(siteOrigin, path, title, description, location.search);
};

export default function Category({ loaderData }: Route.ComponentProps) {
  // Keyed by slug: another category is another listing, not this one updated.
  return (
    <Catalog key={loaderData.slug} category={loaderData.slug} publisher="" seed={loaderData.seed} />
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <StatusPage status={errorStatus(error)} />;
}
