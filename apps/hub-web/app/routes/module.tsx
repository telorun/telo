import { data, isRouteErrorResponse, Link, redirect } from "react-router";

import type { Route } from "./+types/module";
import { hubContext } from "@/hub-context.server";
import { unavailableResponse } from "@/hub-reader.server";
import {
  canonicalLink,
  moduleDescription,
  moduleTitle,
  statusTitle,
} from "@/module-head";
import { modulePagePath, refFromPath } from "@/module-ref";
import { ModulePage } from "@/ModulePage";
import { errorStatus, StatusPage } from "@/StatusPage";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const ref = refFromPath(params["*"] ?? "");
  const pagePath = ref === null ? null : modulePagePath(ref);
  if (ref === null || pagePath === null) throw data(null, { status: 404 });

  const url = new URL(request.url);
  if (url.pathname !== pagePath) throw redirect(`${pagePath}${url.search}`, 301);

  const read = await context.get(hubContext).hub.readModule(ref, url.searchParams.get("version") ?? "");
  if (read.kind === "absent") throw data({ pagePath }, { status: 404 });
  if (read.kind === "unavailable") throw unavailableResponse(read, `reading module ${ref}`);
  return { page: read.page, pagePath };
}

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

// The canonical is the page path, never the request URL, so `?version=` pages
// point at the unversioned page.
export const meta: Route.MetaFunction = ({ loaderData, matches, error }) => {
  if (error || !loaderData) return [{ title: statusTitle(errorStatus(error)) }];
  return [
    { title: moduleTitle(loaderData.page) },
    { name: "description", content: moduleDescription(loaderData.page) },
    canonicalLink(matches[0].loaderData.siteOrigin, loaderData.pagePath),
  ];
};

export default function Module({ loaderData }: Route.ComponentProps) {
  return <ModulePage page={loaderData.page} pagePath={loaderData.pagePath} />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const pagePath =
    isRouteErrorResponse(error) && error.status === 404
      ? (error.data as { pagePath?: string } | null)?.pagePath
      : undefined;
  if (!pagePath) return <StatusPage status={errorStatus(error)} />;
  return (
    <StatusPage status={404} heading="Module not found">
      The hub tracks no such module, or not at that version. The module&apos;s own page is{" "}
      <Link to={pagePath} className="font-mono text-foreground underline underline-offset-2">
        {pagePath}
      </Link>
      .
    </StatusPage>
  );
}
