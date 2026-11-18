/** A visitor host the relay answers from a share's tunnel. */
export interface VisitorHost {
  shareId: string;
  port: number;
}

// `[<label>--]<port>-<id>`, read from the right: the id is the last twelve
// characters, the port the digits before them, and anything before `--` the
// need label the secondary template put there.
const SHARE_LABEL = /^(?:[a-z0-9-]+--)?([1-9][0-9]{0,4})-([a-z2-7]{12})$/;

/**
 * The share and port a `Host` names beneath `baseDomain`, or `undefined` for a
 * host of any other form. The port and the trailing dot are ignored; case is not
 * significant.
 */
export function parseVisitorHost(host: string | undefined, baseDomain: string): VisitorHost | undefined {
  if (host === undefined) return undefined;
  const name = hostname(host);
  const suffix = `.${baseDomain.toLowerCase().replace(/\.$/, "")}`;
  if (!name.endsWith(suffix)) return undefined;
  const match = SHARE_LABEL.exec(name.slice(0, -suffix.length));
  if (!match) return undefined;
  const port = Number(match[1]);
  return port <= 65535 ? { shareId: match[2]!, port } : undefined;
}

/** A `Host` header's name, lowercased, without its port or trailing dot. */
function hostname(host: string): string {
  const lower = host.trim().toLowerCase();
  const withoutPort = lower.startsWith("[") ? lower : lower.replace(/:[0-9]*$/, "");
  return withoutPort.replace(/\.$/, "");
}
