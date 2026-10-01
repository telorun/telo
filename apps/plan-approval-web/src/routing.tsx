import * as React from "react";

export type Route =
  | { name: "inbox" }
  | { name: "plan"; id: string }
  | { name: "settings" }
  | { name: "runners" }
  | { name: "runner"; runner: string }
  | { name: "notFound"; path: string };

export function routeFromPath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "inbox" };
  if (parts[0] === "plans" && parts.length === 2) return { name: "plan", id: parts[1] };
  if (parts[0] === "settings" && parts.length === 1) return { name: "settings" };
  if (parts[0] === "runners" && parts.length === 1) return { name: "runners" };
  if (parts[0] === "runners" && parts.length === 2) return { name: "runner", runner: parts[1] };
  return { name: "notFound", path: pathname };
}

const NAVIGATE = "plan-approval:navigate";

/** The current route, following Back/Forward and `navigate`. */
export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(() => routeFromPath(window.location.pathname));
  React.useEffect(() => {
    const update = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE, update);
    };
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

/** A same-app link: a real href for new tabs, pushState for a plain click. */
export function AppLink({ href, onClick, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

export const paths = {
  inbox: () => "/",
  plan: (id: string) => `/plans/${encodeURIComponent(id)}`,
  settings: () => "/settings",
  runners: () => "/runners",
  runner: (name: string) => `/runners/${encodeURIComponent(name)}`,
};
