import * as React from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

// Geist ships with the site, as it does with studio, so a page load asks no
// font host for anything.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import type { Route } from "./+types/root";
import stylesheet from "./globals.css?url";
import { hubContext, hubContextValue } from "@/hub-context.server";
import { HubOriginsProvider } from "@/hub-origins";
import { statusTitle } from "@/module-head";
import { ProductColors } from "@/ProductSwitcher";
import { SessionProvider } from "@/session";
import { SiteFooter } from "@/SiteFooter";
import { SiteHeader, THEME_KEY } from "@/SiteHeader";
import { errorStatus, StatusPage } from "@/StatusPage";
import hubMark from "@/telo-hub-mark.svg";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: hubMark },
  { rel: "stylesheet", href: stylesheet },
];

/** Error statuses own their caching whichever route produced them, for
 *  documents, `.data` requests and resource routes alike: a 404 is revalidated,
 *  a 5xx is never stored, and a 503 says when to come back. Routes own the
 *  headers of their 2xx responses. */
function applyErrorCachePolicy(response: Response): Response {
  const { status } = response;
  if (status !== 404 && status < 500) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", status === 404 ? "no-cache" : "no-store");
  if (status === 503) headers.set("Retry-After", "60");
  return new Response(response.body, { status, statusText: response.statusText, headers });
}

export const middleware: Route.MiddlewareFunction[] = [
  async ({ context }, next) => {
    context.set(hubContext, hubContextValue);
    return applyErrorCachePolicy(await next());
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { settings, products } = context.get(hubContext);
  return {
    browserApiOrigin: settings.browserApiOrigin,
    siteOrigin: settings.siteOrigin,
    oidc: settings.oidc,
    plausibleScriptUrl: settings.plausibleScriptUrl,
    products: (await products?.list()) ?? null,
  };
}

/** The origins are fixed for the server's lifetime, and the product list is
 *  the one the page was served with. */
export function shouldRevalidate() {
  return false;
}

export const meta: Route.MetaFunction = ({ error }) =>
  error ? [{ title: statusTitle(errorStatus(error)) }] : [];

/** Applies the reader's stored theme, or the OS colour scheme when they have
 *  chosen none. Runs before first paint, so the server markup never has to
 *  guess. Storage that cannot be read (a browser that blocks it) is the same as
 *  no choice made. */
const COLOUR_SCHEME = `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")})()`;

const ANALYTICS_INIT = `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`;

export function Layout({ children }: { children: React.ReactNode }) {
  const origins = useRouteLoaderData<typeof loader>("root");
  const browserApiOrigin = origins?.browserApiOrigin ?? null;
  const oidc = origins?.oidc ?? null;
  const plausibleScriptUrl = origins?.plausibleScriptUrl ?? null;
  const siteOrigin = origins?.siteOrigin ?? null;
  const products = origins?.products ?? null;
  const oidcClient = React.useMemo(
    () => (oidc && siteOrigin ? { ...oidc, siteOrigin } : null),
    [oidc, siteOrigin],
  );
  return (
    // The colour-scheme script sets `class` before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: COLOUR_SCHEME }} />
        {plausibleScriptUrl && (
          <>
            <script async src={plausibleScriptUrl} />
            <script dangerouslySetInnerHTML={{ __html: ANALYTICS_INIT }} />
          </>
        )}
        <Meta />
        <Links />
        {products && <ProductColors products={products} />}
      </head>
      <body className="flex min-h-dvh flex-col antialiased">
        <HubOriginsProvider value={origins ?? null}>
          <SessionProvider client={oidcClient}>
            <SiteHeader browserApiOrigin={browserApiOrigin} products={products} />
            <main className="mx-auto flex w-full max-w-[88rem] flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
              {children}
            </main>
            <SiteFooter />
          </SessionProvider>
        </HubOriginsProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <StatusPage status={errorStatus(error)} />;
}
