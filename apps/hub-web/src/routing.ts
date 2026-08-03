import * as React from "react";

import { refFromPath } from "@/module-ref";

/** Two routes: the search/register shell, and a module's own page.
 *
 *  Hand-rolled rather than pulling in a router: there are two routes and one
 *  optional query param, and the History API covers that directly. The module
 *  page needs a real path (not a drawer over `?q=`) so it can be linked, shared
 *  and — later — indexed; that is the whole reason routing exists here.
 *
 *  GitHub Pages serves a static tree, so a deep link 404s at the CDN. The deploy
 *  workflow copies `index.html` to `404.html`, which makes the SPA the fallback
 *  for any unmatched path and lets this resolve the route client-side. */
export type Route = { name: "home" } | { name: "module"; ref: string; version: string };

export function routeFromLocation(): Route {
  const ref = refFromPath(window.location.pathname);
  if (!ref) return { name: "home" };
  // Version is a query param rather than a path segment: a ref's own path has
  // an unbounded number of segments, so a trailing one could not be told apart
  // from the ref itself.
  const version = new URLSearchParams(window.location.search).get("version") ?? "";
  return { name: "module", ref, version };
}

/** The current route, kept in sync with Back/Forward. */
export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(routeFromLocation);

  React.useEffect(() => {
    const onPop = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // `navigate` dispatches this so a programmatic push updates the route too —
  // pushState alone fires no event.
  React.useEffect(() => {
    const onNav = () => setRoute(routeFromLocation());
    window.addEventListener("telo:navigate", onNav);
    return () => window.removeEventListener("telo:navigate", onNav);
  }, []);

  return route;
}

/** Push a path and tell `useRoute` about it. */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event("telo:navigate"));
  window.scrollTo(0, 0);
}
