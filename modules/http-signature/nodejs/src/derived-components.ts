import { SignatureMalformed } from "./signature-failure.js";

const URI = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

export const DERIVED_COMPONENTS: ReadonlySet<string> = new Set([
  "@method",
  "@target-uri",
  "@authority",
  "@scheme",
  "@request-target",
  "@path",
  "@query",
  "@query-param",
]);

export interface TargetParts {
  scheme: string;
  authority: string;
  path: string;
  /** `undefined` when the URI has no `?`. */
  query: string | undefined;
}

export function splitTargetUri(targetUri: string): TargetParts {
  const match = URI.exec(targetUri);
  if (!match) throw new SignatureMalformed("the request's target URI is not absolute");
  const scheme = match[1]!.toLowerCase();
  let authority = (match[2] ?? "").toLowerCase();
  const port = /:(\d+)$/.exec(authority);
  if (port && DEFAULT_PORTS[scheme] === port[1]) authority = authority.slice(0, -port[0].length);
  return { scheme, authority, path: match[3] || "/", query: match[4] };
}

// RFC 9421 §2.2.8: decode as application/x-www-form-urlencoded, encode again with only unreserved left bare.
function reencode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeForm(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    throw new SignatureMalformed("the query holds an invalid percent escape");
  }
}

export function queryParam(query: string | undefined, name: string): string {
  const wanted = reencode(name);
  const values: string[] = [];
  for (const pair of (query ?? "").split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decodeForm(eq < 0 ? pair : pair.slice(0, eq));
    if (reencode(key) === wanted) values.push(reencode(decodeForm(eq < 0 ? "" : pair.slice(eq + 1))));
  }
  if (values.length !== 1) {
    throw new SignatureMalformed(`the query holds ${values.length === 0 ? "no" : "more than one"} parameter ${JSON.stringify(name)}`);
  }
  return values[0]!;
}

export function derivedValue(
  name: string,
  request: { method: string; targetUri: string },
  paramName: string | undefined,
): string {
  if (name === "@method") return request.method;
  if (name === "@target-uri") return request.targetUri;
  const parts = splitTargetUri(request.targetUri);
  switch (name) {
    case "@authority": return parts.authority;
    case "@scheme": return parts.scheme;
    case "@path": return parts.path;
    case "@query": return `?${parts.query ?? ""}`;
    case "@request-target": return parts.query === undefined ? parts.path : `${parts.path}?${parts.query}`;
    case "@query-param":
      if (paramName === undefined) throw new SignatureMalformed("@query-param names no parameter");
      return queryParam(parts.query, paramName);
    default: throw new SignatureMalformed(`the derived component ${JSON.stringify(name)} is not supported`);
  }
}
