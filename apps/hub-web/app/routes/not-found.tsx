import { data } from "react-router";

import type { Route } from "./+types/not-found";
import { statusTitle } from "@/module-head";
import { errorStatus, StatusPage } from "@/StatusPage";

export function loader(): never {
  throw data(null, { status: 404 });
}

export const meta: Route.MetaFunction = ({ error }) => [{ title: statusTitle(errorStatus(error)) }];

// The loader always throws, so the boundary is all the route renders. The
// component is never rendered: it makes this a page route rather than a resource
// route, and without one React Router warns on every 404 that the leaf route has
// no element.
export default function NotFound(): null {
  return null;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <StatusPage status={errorStatus(error)} />;
}
