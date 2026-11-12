import type { IncomingMessage } from "node:http";

/**
 * A request target whose path holds a percent-escape that does not decode is
 * one no route matches. The router decodes the whole path before it routes and
 * answers a bad escape with its own JSON body, before any hook runs, so the
 * target is rewritten for routing to a decodable one and flagged; the flag
 * makes the router's route table miss (`malformedConstraint`), which sends the
 * request down the not-found path of the prefix it names, and a first
 * `onRequest` hook puts the target back as sent.
 */
export class MalformedTargets {
  private readonly sent = new WeakMap<IncomingMessage, string>();

  /** The target as the router should see it; flags a request the router cannot decode. */
  rewrite(req: IncomingMessage): string {
    const url = req.url ?? "/";
    const repaired = repairedTarget(url);
    if (repaired === url) return url;
    this.sent.set(req, url);
    return repaired;
  }

  /** The target as sent, when it was rewritten. */
  restore(req: IncomingMessage): void {
    const url = this.sent.get(req);
    if (url !== undefined) req.url = url;
  }

  /** A derived constraint no route carries: while set, no route matches. */
  constraint() {
    return {
      name: "teloMalformedTarget",
      mustMatchWhenDerived: true,
      storage() {
        return { get: () => null, set() {} };
      },
      deriveConstraint: (req: IncomingMessage) => (this.sent.has(req) ? true : undefined),
    };
  }
}

const ESCAPE_RUN = /(?:%[0-9a-fA-F]{2})+/g;

/**
 * The target with each escape the router cannot decode written as a literal
 * percent sign; the target itself when every escape decodes. Only the path
 * (up to `?` or `#`) is read, as the router reads it.
 */
function repairedTarget(url: string): string {
  let end = url.length;
  for (const delimiter of ["?", "#"]) {
    const at = url.indexOf(delimiter, 1);
    if (at !== -1 && at < end) end = at;
  }
  const path = url.slice(0, end);
  if (!path.includes("%")) return url;
  const literal = (text: string) => text.replaceAll("%", "%25");
  let repaired = "";
  let from = 0;
  for (const run of path.matchAll(ESCAPE_RUN)) {
    repaired += literal(path.slice(from, run.index));
    repaired += decodes(run[0]) ? run[0] : literal(run[0]);
    from = run.index + run[0].length;
  }
  repaired += literal(path.slice(from));
  return repaired === path ? url : repaired + url.slice(end);
}

function decodes(escapes: string): boolean {
  try {
    decodeURIComponent(escapes);
    return true;
  } catch {
    return false;
  }
}
