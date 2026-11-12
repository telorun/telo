import { readBinding, type Binding } from "./bindings.js";
import type { Host } from "./host.js";
import { readRelative, resolveRelative, type RelativeFormat } from "./relative-time.js";
import { underMount } from "./renderer-context.js";
import { networkError, responseError } from "./ui-error.js";

export type Operator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in" | "absent";

/** One query parameter of a collection request. A filter holding a value
 *  relative to now carries the format it resolves to, and is resolved before
 *  it is sent ({@link resolveParams}). */
export type Param = [name: string, value: string, relative?: RelativeFormat];

/** The parameters as sent at `now`: each relative value resolved, every other as it is. */
export function resolveParams(params: readonly Param[], now: Date): Param[] {
  return params.map(([name, value, relative]) => {
    const moved = relative === undefined ? undefined : readRelative(value);
    return moved === undefined || relative === undefined ? [name, value] : [name, resolveRelative(moved, relative, now)];
  });
}

/** Every parameter's value, or a refusal for one still relative: a read resolves its filters before it sends them. */
function sentValue([name, value, relative]: Param): string {
  if (relative !== undefined) throw new Error(`The filter '${name}' holds a value relative to now ('${value}') that was never resolved before it was sent.`);
  return value;
}

/** The parameter a filter sends: `<property>=` for equality, `<property>.<operator>=` otherwise. */
export function filterParam(property: string, operator: Operator, value: string): Param {
  return [operator === "eq" ? property : `${property}.${operator}`, value];
}

/** The equalities a source sends, each binding read over the roots in scope;
 *  nothing when one of them holds nothing, since the source then reads nothing. */
export function boundFilters(filters: Record<string, Binding> | undefined, roots: Readonly<Record<string, unknown>>): Param[] | undefined {
  const params: Param[] = [];
  for (const [name, binding] of Object.entries(filters ?? {})) {
    const read = readBinding(binding, roots);
    if (!read.present || read.value === null) return undefined;
    params.push([name, String(read.value)]);
  }
  return params;
}

export interface CollectionView {
  limit: number;
  cursor?: string;
  /** One property; `-` before it for descending. */
  sort?: string;
  filters: Param[];
}

/** `url` is the collection's URL as requested: an app-relative `basePath` under the mount. */
export function collectionUrl(url: string, view: CollectionView): string {
  const query = new URLSearchParams();
  query.set("limit", String(view.limit));
  if (view.cursor !== undefined) query.set("cursor", view.cursor);
  if (view.sort !== undefined) query.set("sort", view.sort);
  for (const param of view.filters) query.append(param[0], sentValue(param));
  return `${url}?${query}`;
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

export async function fetchPage(host: Host, url: string, view: CollectionView): Promise<CollectionPage> {
  const response = await send(host, collectionUrl(url, view), { headers: { accept: "application/json" } });
  return (await response.json()) as CollectionPage;
}

/** A request of the collection contract: an app-relative path and its query
 *  parameters in the order sent. */
export interface CollectionRequest {
  path: string;
  params: Param[];
}

/** The URL a request is sent to: its path under the mount, its parameters in order. */
export function requestUrl(prefix: string, request: CollectionRequest): string {
  const query = new URLSearchParams();
  for (const param of request.params) query.append(param[0], sentValue(param));
  return `${underMount(prefix, request.path)}?${query}`;
}

/** One page of a listing read, as a collection answers it. */
export async function fetchRequest(host: Host, prefix: string, request: CollectionRequest): Promise<CollectionPage> {
  const response = await send(host, requestUrl(prefix, request), { headers: { accept: "application/json" } });
  return (await response.json()) as CollectionPage;
}

/** One present value of a property, with how many records hold it. */
export interface FacetValue {
  value: unknown;
  count: number;
}

export interface FacetPage {
  values: FacetValue[];
  next: string | null;
}

/** One page of a facet request's answer. */
export async function fetchFacet(host: Host, prefix: string, request: CollectionRequest): Promise<FacetPage> {
  const response = await send(host, requestUrl(prefix, request), { headers: { accept: "application/json" } });
  return (await response.json()) as FacetPage;
}
