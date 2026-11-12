/**
 * Which page an address opens, matched segment by segment — on the server, for
 * the shell's status and the page document, and in the browser, for which
 * clicks are moves within the application. Shared so both answer alike.
 */

const VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** The page an address opens: its declared path, and its variables as the address fills them. */
export interface PageMatch {
  path: string;
  params: Record<string, string>;
}

const segmentsOf = (path: string): string[] => (path === "/" ? [] : path.slice(1).split("/"));

/** A segment percent-decoded, or nothing when its encoding is malformed. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed encoding names no value: the variable does not match.
    return undefined;
  }
}

/**
 * The variables a page path takes from an address — its encoded path, the
 * query left out — or nothing when the address is not one of the page's. A
 * literal segment matches itself; a `{name}` segment one non-empty segment,
 * percent-decoded.
 */
function matchOne(template: string, address: string): Record<string, string> | undefined {
  const wanted = segmentsOf(template);
  const given = segmentsOf(address);
  if (wanted.length !== given.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const name = VARIABLE.exec(segment)?.[1];
    if (name === undefined) {
      if (segment !== given[index]) return undefined;
      continue;
    }
    const value = given[index] === "" ? undefined : decoded(given[index]);
    if (value === undefined) return undefined;
    params[name] = value;
  }
  return params;
}

/** Whether `one` is preferred to `other`: at the first segment where one is literal and the other a variable, the literal. */
function morePrecise(one: string, other: string): boolean {
  const ones = segmentsOf(one);
  const others = segmentsOf(other);
  for (const [index, segment] of ones.entries()) {
    const literal = !VARIABLE.test(segment);
    const otherLiteral = !VARIABLE.test(others[index] ?? "");
    if (literal !== otherLiteral) return literal;
  }
  return false;
}

/**
 * The page of `pages` an address opens: of those whose segments it matches, the
 * one with a literal segment first where the others have a variable
 * (`/plans/new` over `/plans/{id}`). Nothing when none matches — a malformed
 * percent-encoded segment included.
 */
export function matchPage(pages: readonly string[], address: string): PageMatch | undefined {
  let best: PageMatch | undefined;
  for (const path of pages) {
    const params = matchOne(path, address);
    if (params === undefined) continue;
    if (best === undefined || morePrecise(path, best.path)) best = { path, params };
  }
  return best;
}
