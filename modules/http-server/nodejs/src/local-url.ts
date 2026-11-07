import net from "node:net";

/**
 * The URL a socket bound to `address:port` is reached at from the same machine:
 * a wildcard address is written as `localhost`, an IPv6 literal in brackets
 * without its zone, which a URL cannot carry. It is the socket's URL, never a
 * public address.
 */
export function localUrlOf(scheme: "http" | "https", address: string, port: number): string {
  const wildcard = address === "0.0.0.0" || address === "::";
  const host = wildcard
    ? "localhost"
    : net.isIPv6(address)
      ? `[${address.split("%")[0]}]`
      : address;
  return `${scheme}://${host}:${port}`;
}
