import type { FastifyInstance } from "fastify";
import { hostClasses, refuseDuplicateRoute, type MountHostEntry } from "./host-precedence.js";

/**
 * Which routes a host reaches, recorded as each mount registers them — what the
 * OpenAPI document an `Http.Reference` serves is filtered by, so the document a
 * host is handed lists exactly the routes that host can call. Two mounts of one
 * precedence class registering the same method and path are refused here.
 */
const HOST_ROUTES = "teloHostRoutes";

/** A route's identity in the router: its method and its path with every
 *  parameter name erased, since `/u/:id` and `/u/:uid` are one route. */
function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\{[^}]*\}/g, "{}")}`;
}

function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

export class HostRoutes {
  private readonly byRoute = new Map<string, MountHostEntry[]>();
  private readonly mounts: MountHostEntry[] = [];

  constructor(private readonly server: string) {}

  /** The mounts that may reach a host, as precedence reads them. */
  setMounts(entries: readonly MountHostEntry[]): void {
    this.mounts.splice(0, this.mounts.length, ...entries);
  }

  record(url: string, method: string | readonly string[], entry: MountHostEntry): void {
    const path = openApiPath(url);
    for (const m of Array.isArray(method) ? method : [method]) {
      const key = routeKey(String(m), path);
      const holders = this.byRoute.get(key) ?? [];
      if (holders.some((holder) => holder.id === entry.id)) continue;
      refuseDuplicateRoute(this.server, String(m).toUpperCase(), url, entry, holders);
      holders.push(entry);
      this.byRoute.set(key, holders);
    }
  }

  /** Whether `host` reaches the operation `method path`: a mount registering it
   *  is in one of the host's precedence classes. An operation no mount
   *  registered here is left in the document. */
  reaches(path: string, method: string, host: string): boolean {
    const holders = this.byRoute.get(routeKey(method, path));
    if (!holders) return true;
    const reached = new Set(hostClasses(this.mounts, host).flatMap((c) => [...c.ids]));
    return holders.some((holder) => reached.has(holder.id));
  }

  /** Whether any mount restricts its hosts — when none does, every host reaches
   *  every route and the document is served unfiltered. */
  get restricted(): boolean {
    return this.mounts.some((mount) => mount.restricted);
  }
}

export function publishHostRoutes(app: FastifyInstance, routes: HostRoutes): void {
  app.decorate(HOST_ROUTES, routes);
}

export function hostRoutesOf(app: FastifyInstance): HostRoutes | undefined {
  return (app as unknown as Record<string, unknown>)[HOST_ROUTES] as HostRoutes | undefined;
}

const OPERATION_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** The document with every operation `host` cannot reach removed, and a path
 *  left with none removed whole. */
export function documentForHost(
  document: Record<string, unknown>,
  routes: HostRoutes | undefined,
  host: string,
): Record<string, unknown> {
  if (!routes?.restricted) return document;
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return document;
  const kept: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(paths)) {
    const filtered: Record<string, unknown> = {};
    let operations = 0;
    for (const [key, value] of Object.entries(item)) {
      if (!OPERATION_METHODS.has(key)) {
        filtered[key] = value;
        continue;
      }
      if (!routes.reaches(path, key, host)) continue;
      filtered[key] = value;
      operations++;
    }
    if (operations > 0) kept[path] = filtered;
  }
  return { ...document, paths: kept };
}
