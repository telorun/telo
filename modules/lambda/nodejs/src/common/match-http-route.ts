/**
 * OpenAPI-style path matcher. Matches an incoming HTTP path (e.g.
 * `/users/123/orders/abc`) against a template path with `{paramName}`
 * placeholders (e.g. `/users/{userId}/orders/{orderId}`), extracting the
 * concrete param values when the template matches.
 *
 * Used by `Lambda.HttpApi`'s controller to route incoming API Gateway HTTP API
 * v2 events to the matching `routes[]` entry. Mirrors the same matching logic
 * http-server's Fastify-backed router applies (Fastify uses `:param` syntax
 * internally; the http-server controller translates `{param}` → `:param` at
 * route registration time). For Lambda, AWS doesn't run a router — the entire
 * Lambda artifact receives all events, so the controller has to do the match
 * itself.
 */
export interface RouteMatch {
  /** Path parameter values extracted from the template placeholders. */
  params: Record<string, string>;
}

/**
 * Returns the extracted path params when `template` matches `actualPath` (HTTP
 * method match is the caller's concern). Returns `null` when the path doesn't
 * match.
 *
 * Matching is exact at the segment level: `/users/{id}` matches `/users/x` but
 * not `/users/x/extra` or `/users`. Trailing slashes are normalised away (a
 * template `/users/` and a path `/users` are treated as equivalent).
 *
 * The trailing-segment `{name+}` placeholder is greedy — it captures the
 * remaining path segments as a single `/`-joined string. Matches AWS API
 * Gateway's `{proxy+}` syntax for catch-all routes. Must be the final segment;
 * a `+`-greedy placeholder in any earlier position is treated as a normal
 * `{name+}` segment match (one segment whose name includes the literal `+`).
 */
export function matchHttpRoute(template: string, actualPath: string): RouteMatch | null {
  const templateSegments = splitPath(template);
  const actualSegments = splitPath(actualPath);

  const lastTemplate = templateSegments[templateSegments.length - 1];
  const isGreedyTail =
    !!lastTemplate && lastTemplate.startsWith("{") && lastTemplate.endsWith("+}");

  if (isGreedyTail) {
    // Greedy tail must have at least as many actual segments as fixed prefix
    // segments. The greedy segment itself absorbs ≥1 trailing segments.
    if (actualSegments.length < templateSegments.length) return null;
  } else if (templateSegments.length !== actualSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  const fixedCount = isGreedyTail ? templateSegments.length - 1 : templateSegments.length;
  for (let i = 0; i < fixedCount; i++) {
    const t = templateSegments[i]!;
    const a = actualSegments[i]!;
    if (t.startsWith("{") && t.endsWith("}")) {
      const decoded = safeDecodeURIComponent(a);
      // Malformed percent-encoding in a path segment is treated as "no match"
      // rather than thrown — surfacing it as a 500 would let an attacker turn
      // any route into a crash by sending `/users/%ZZ`.
      if (decoded === null) return null;
      params[t.slice(1, -1)] = decoded;
    } else if (t !== a) {
      return null;
    }
  }
  if (isGreedyTail) {
    const name = lastTemplate!.slice(1, -2);
    const decodedTail: string[] = [];
    for (const seg of actualSegments.slice(fixedCount)) {
      const d = safeDecodeURIComponent(seg);
      if (d === null) return null;
      decodedTail.push(d);
    }
    params[name] = decodedTail.join("/");
  }
  return { params };
}

function safeDecodeURIComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function splitPath(p: string): string[] {
  // Strip leading/trailing slashes and split. An empty string after splitting
  // means a root path "/" — represent as a zero-segment array so it matches
  // exactly one template ("/" or "").
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? [] : trimmed.split("/");
}
