import type { Host } from "./host.js";
import { networkError, responseError } from "./ui-error.js";

export type Operator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in";

/** One query parameter of a collection request. */
export type Param = [name: string, value: string];

/** The parameter a filter sends: `<property>=` for equality, `<property>.<operator>=` otherwise. */
export function filterParam(property: string, operator: Operator, value: string): Param {
  return [operator === "eq" ? property : `${property}.${operator}`, value];
}

export interface CollectionView {
  limit: number;
  cursor?: string;
  /** One property; `-` before it for descending. */
  sort?: string;
  filters: Param[];
}

export function collectionUrl(basePath: string, view: CollectionView): string {
  const query = new URLSearchParams();
  query.set("limit", String(view.limit));
  if (view.cursor !== undefined) query.set("cursor", view.cursor);
  if (view.sort !== undefined) query.set("sort", view.sort);
  for (const [name, value] of view.filters) query.append(name, value);
  return `${basePath}?${query}`;
}

export interface CollectionPage {
  rows: Record<string, unknown>[];
  total: number;
  next: string | null;
}

/** A request whose failure is a `UiError`: no response, or one that is not a success. */
export async function send(host: Host, url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await host.fetch(url, init);
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await responseError(response);
  return response;
}

export async function fetchPage(host: Host, basePath: string, view: CollectionView): Promise<CollectionPage> {
  const response = await send(host, collectionUrl(basePath, view), { headers: { accept: "application/json" } });
  return (await response.json()) as CollectionPage;
}
