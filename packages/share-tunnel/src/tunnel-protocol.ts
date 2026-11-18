// The numbers of tunnel protocol generation 1 (`specs/tunnel-protocol.md`).
// A change to any of them is a new generation.

export const TUNNEL_GENERATION = 1;

/** The WebSocket subprotocol naming generation 1. */
export const TUNNEL_SUBPROTOCOL = "telo-share-1";

/** Every generation this client offers, most preferred first. */
export const TUNNEL_SUBPROTOCOLS_OFFERED: readonly string[] = [TUNNEL_SUBPROTOCOL];

/** The largest text message either side accepts, in UTF-8 bytes. */
export const TUNNEL_TEXT_MESSAGE_MAX_BYTES = 64 * 1024;

/** The largest binary message either side accepts, in bytes. */
export const TUNNEL_BINARY_MESSAGE_MAX_BYTES = 1024 * 1024;

/** The request header the relay sets on every HTTP/2 stream: the target port. */
export const SHARE_PORT_HEADER = "telo-share-port";

export const TunnelCloseCode = {
  protocolError: 4400,
  credentialRefused: 4401,
  shareGone: 4404,
  timedOut: 4408,
  superseded: 4409,
  ownerLimit: 4429,
  runnerCapacity: 4503,
} as const;

/** The relay closes `4408` when no `hello` arrives within this. */
export const TUNNEL_HELLO_TIMEOUT_MS = 10_000;

/** The relay pings this often. */
export const TUNNEL_PING_INTERVAL_MS = 20_000;

/** A side that has received nothing for this long closes `4408`. */
export const TUNNEL_SILENCE_MS = 45_000;

/** `auth` is sent at least this long before the last presented token expires. */
export const TUNNEL_REAUTH_MIN_LEAD_MS = 60_000;

/** The `https://` (or `http://`) URL a tunnel proof's `htu` names for a `wss://` (or `ws://`) tunnel URL. */
export function tunnelProofUrl(tunnelUrl: string): string {
  const url = new URL(tunnelUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else throw new TypeError(`a tunnel URL is ws:// or wss://, not ${url.protocol}//: ${tunnelUrl}`);
  return url.href;
}
