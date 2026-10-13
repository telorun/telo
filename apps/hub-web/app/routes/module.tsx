import { data, isRouteErrorResponse, Link, redirect } from "react-router";

import type { Route } from "./+types/module";
import { hubContext } from "@/hub-context.server";
import type { ModulePage as ModulePageData } from "@/api";
import { type HubReader, unavailableResponse } from "@/hub-reader.server";
import { readKindSchemas } from "@/kind-schema.server";
import {
  canonicalLink,
  moduleDescription,
  moduleSchema,
  moduleTitle,
  shareTags,
  statusTitle,
} from "@/module-head";
import { modulePagePath, refFromPath } from "@/module-ref";
import { ModulePage, type RelatedModules } from "@/ModulePage";
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
  // The field tables come from the version's own manifest. Without it — a hub
  // that does not serve manifests, or one that does not answer — the page is
  // still the module's page, so a failed read costs the tables and nothing else.
  const hub = context.get(hubContext).hub;
  const [manifest, related] = await Promise.all([
    hub.readManifest(ref, read.page.module.version),
    readRelated(hub, read.page),
  ]);
  if (manifest.kind === "unavailable") {
    console.error(`hub unavailable (${manifest.reason}) while reading the manifest of ${ref}: ${manifest.detail}`);
  }
  const schemas = manifest.kind === "found" ? readKindSchemas(manifest.text) : null;
  return { page: read.page, pagePath, schemas, related };
}

/** The modules a page links out to beyond its own: who uses it, and who
 *  implements each of its contracts. Read here so those links are in the markup
 *  a crawler reads — they are how one module's page leads to the next. A list
 *  the hub did not answer is `null`, and the browser asks for it instead. */
async function readRelated(hub: HubReader, page: ModulePageData): Promise<RelatedModules> {
  const contracts = page.kinds.filter((k) => k.abstract);
  const [dependents, ...implementations] = await Promise.all([
    (page.dependents ?? 0) > 0 ? hub.readDependents(page.module.ref) : null,
    ...contracts.map((k) => hub.readImplementations(k.ref ?? page.module.ref, k.kind)),
  ]);
  return {
    dependents: dependents?.kind === "found" ? dependents.items : null,
    implementations: Object.fromEntries(
      contracts.map((k, i) => {
        const read = implementations[i];
        return [k.kind, read.kind === "found" ? read.items : null];
      }),
    ),
  };
}

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

// The canonical is the page path, never the request URL, so `?version=` pages
// point at the unversioned page.
export const meta: Route.MetaFunction = ({ loaderData, matches, error }) => {
  if (error || !loaderData) return [{ title: statusTitle(errorStatus(error)) }];
  const { siteOrigin } = matches[0].loaderData;
  const title = moduleTitle(loaderData.page);
  const description = moduleDescription(loaderData.page);
  return [
    { title },
    { name: "description", content: description },
    canonicalLink(siteOrigin, loaderData.pagePath),
    ...shareTags(siteOrigin, loaderData.pagePath, title, description),
    ...moduleSchema(siteOrigin, loaderData.page, loaderData.pagePath),
  ];
};

export default function Module({ loaderData }: Route.ComponentProps) {
  return (
    <ModulePage
      page={loaderData.page}
      pagePath={loaderData.pagePath}
      schemas={loaderData.schemas}
      related={loaderData.related}
    />
  );
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
