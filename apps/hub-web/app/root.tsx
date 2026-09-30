import * as React from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import stylesheet from "./globals.css?url";
import { hubContext, hubContextValue } from "@/hub-context.server";
import { HubOriginsProvider } from "@/hub-origins";
import { statusTitle } from "@/module-head";
import { errorStatus, StatusPage } from "@/StatusPage";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap",
  },
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

export function loader({ context }: Route.LoaderArgs) {
  const { settings } = context.get(hubContext);
  return { browserApiOrigin: settings.browserApiOrigin, siteOrigin: settings.siteOrigin };
}

/** The origins are fixed for the server's lifetime. */
export function shouldRevalidate() {
  return false;
}

export const meta: Route.MetaFunction = ({ error }) =>
  error ? [{ title: statusTitle(errorStatus(error)) }] : [];

/** Follows the OS colour scheme — the site has no theme toggle of its own. Runs
 *  before first paint, so the server markup never has to guess. */
const COLOUR_SCHEME = `if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");`;

export function Layout({ children }: { children: React.ReactNode }) {
  const origins = useRouteLoaderData<typeof loader>("root");
  return (
    // The colour-scheme script sets `class` before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: COLOUR_SCHEME }} />
        <Meta />
        <Links />
      </head>
      <body className="antialiased">
        <HubOriginsProvider value={origins ?? null}>
          <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-12">
            {children}
          </main>
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
