import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { hostEnv } from "../host-env.js";

/** Egress policy for transport fetches, from `TELO_EGRESS`:
 *  - unset / `open` — no restriction (the default; a developer machine).
 *  - `public-only` — refuse any host that is, or resolves to, a private,
 *    loopback, link-local, or carrier-grade-NAT address.
 *
 *  Built for deployments whose transports fetch attacker-suppliable refs — the
 *  discovery hub's tracker is the first: a registered `oci://10.0.0.5/…` or
 *  `https://169.254.169.254/…` ref must not become a request into the hub's
 *  own network. A guardrail, not isolation: it checks the name a fetch starts
 *  at, so redirect hops are not re-checked, and the check-then-fetch gap is
 *  open to DNS rebinding (a hostile resolver can answer public for the check
 *  and private for the fetch — the classic bypass for this guard shape).
 *  Network-level egress policy on the deployment is the actual boundary;
 *  this guard is defense-in-depth, not a substitute. */
export class EgressDeniedError extends Error {
  constructor(host: string, address: string) {
    super(
      `Egress to '${host}' denied: it resolves to the non-public address ${address} ` +
        `(TELO_EGRESS=public-only). Refusing to fetch from private, loopback, ` +
        `link-local, or CGNAT ranges.`,
    );
    this.name = "EgressDeniedError";
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true; // malformed → deny
  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    lower === "::" ||
    lower === "::1" || // loopback
    lower.startsWith("fc") || // unique-local fc00::/7
    lower.startsWith("fd") ||
    lower.startsWith("fe8") || // link-local fe80::/10
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

/** True when `address` (an IP literal) is not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true; // not an IP literal → caller passed garbage; deny
}

function policyActive(): boolean {
  // Read through `hostEnv()` like every kernel TELO_* read: `boot()` replaces
  // `process.env` with the guardrail proxy that hides manifest-declared keys,
  // so a manifest binding `env: TELO_EGRESS` must not be able to silently
  // switch this security control off.
  return (hostEnv().TELO_EGRESS ?? "").toLowerCase() === "public-only";
}

/** Assert `hostOrUrl` (a `host[:port]` or a full URL) may be fetched under the
 *  active egress policy. No-op unless `TELO_EGRESS=public-only`. An IP-literal
 *  host is judged directly; a hostname is resolved and every returned address
 *  must be public. Throws {@link EgressDeniedError}; DNS failure surfaces as
 *  the underlying error (never a silent pass). */
export async function assertPublicEgress(hostOrUrl: string): Promise<void> {
  if (!policyActive()) return;
  let hostname = hostOrUrl;
  if (hostOrUrl.includes("://")) {
    hostname = new URL(hostOrUrl).hostname;
  } else {
    // Bare host[:port] — URL parsing handles IPv6 brackets and ports.
    hostname = new URL(`https://${hostOrUrl}`).hostname;
  }
  // URL wraps IPv6 literals in brackets; strip for isIP/lookup.
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) throw new EgressDeniedError(bare, bare);
    return;
  }
  const addresses = await lookup(bare, { all: true, verbatim: true });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new EgressDeniedError(bare, address);
  }
}
