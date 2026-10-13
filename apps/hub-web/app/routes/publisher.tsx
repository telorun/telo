import { data, redirect, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/publisher";
import { Catalog } from "@/Catalog";
import { publisherPath } from "@/catalog-filters";
import { readCatalogSeed } from "@/catalog-seed.server";
import { hubContext } from "@/hub-context.server";
import {
  catalogueHead,
  publisherDescription,
  publisherTitle,
  statusTitle,
} from "@/module-head";
import { errorStatus, StatusPage } from "@/StatusPage";

/** One publisher's page: every module under a host and org. A publisher is
 *  derived from refs, so the hub's facet is what says one exists — a path it
 *  does not list is a 404, and a hub that does not answer is a 503. */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const publisher = (params["*"] ?? "").replace(/\/+$/, "");
  if (!publisher) throw data(null, { status: 404 });
  // One address per publisher: a trailing slash or an encoded separator names
  // the same publisher and is sent to its page.
  const url = new URL(request.url);
  if (url.pathname !== publisherPath(publisher)) {
    throw redirect(`${publisherPath(publisher)}${url.search}`, 301);
  }
  const { seed } = await readCatalogSeed(context.get(hubContext).hub, { category: "", publisher });
  if (!seed.publishers || !seed.page) throw new Response(null, { status: 503 });
  const facet = seed.publishers.find((p) => p.publisher === publisher);
  if (!facet) throw data(null, { status: 404 });
  return { publisher, modules: facet.modules, seed };
}

/** Re-read when the publisher changes, never for a change of query string. */
export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams["*"] !== nextParams["*"];
}

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

export const meta: Route.MetaFunction = ({ loaderData, matches, error, location }) => {
  if (error || !loaderData) return [{ title: statusTitle(errorStatus(error)) }];
  const { siteOrigin } = matches[0].loaderData;
  const path = publisherPath(loaderData.publisher);
  const title = publisherTitle(loaderData.publisher);
  const description = publisherDescription(loaderData.publisher, loaderData.modules);
  return catalogueHead(siteOrigin, path, title, description, location.search);
};

export default function Publisher({ loaderData }: Route.ComponentProps) {
  return (
    <Catalog
      key={loaderData.publisher}
      category=""
      publisher={loaderData.publisher}
      seed={loaderData.seed}
    />
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <StatusPage status={errorStatus(error)} />;
}
