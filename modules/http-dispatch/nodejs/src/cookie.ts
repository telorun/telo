import {
  durationNanos,
  durationNanosFromText,
  InvokeError,
  isCelDuration,
  isCelTimestamp,
  parseTimestamp,
  timestampNanos,
} from "@telorun/sdk";

/**
 * A cookie declaration's normalized attributes — the record every `Cookie`
 * implementation publishes as its reading. `name` is the name on the wire, its
 * prefix included, and `domain` is null when the cookie is host-only.
 */
export interface CookieAttributes {
  readonly name: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "Strict" | "Lax" | "None";
  readonly partitioned: boolean;
  readonly domain: string | null;
  readonly path: string;
}

/** What one response writes for a cookie: its value and lifetime, as the
 *  entry's CEL produced them. */
export interface CookieWrite {
  readonly value?: unknown;
  readonly maxAge?: unknown;
  readonly expires?: unknown;
}

/** The code a response is refused with when a computed part of a cookie cannot
 *  be sent. */
export const ERR_COOKIE_VALUE_INVALID = "ERR_COOKIE_VALUE_INVALID";

const COOKIE_VALUE = /^(?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*|"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*")$/;
const CLEARED_EXPIRES = new Date(0).toUTCString();
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * The cookies of a `Cookie` request header (RFC 6265 §5.4): each `name=value`
 * pair split at its first `=` and trimmed, a pair without `=` skipped, the first
 * occurrence of a name kept, and every value passed through as written.
 */
export function parseCookieHeader(header: string | readonly string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  const text = typeof header === "string" ? header : header.join("; ");
  for (const pair of text.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    Object.defineProperty(cookies, name, {
      value: pair.slice(separator + 1).trim(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cookies;
}

/**
 * One `Set-Cookie` line. A max age of zero or less clears the cookie: the value
 * is empty unless one is given, `Max-Age=0`, and `Expires` in the past unless one
 * is given — under the declaration's own scope, so the browser drops it.
 */
export function setCookieLine(cookie: CookieAttributes, write: CookieWrite): string {
  const value = write.value === undefined ? "" : cookieValue(cookie.name, write.value);
  const maxAge = write.maxAge === undefined ? undefined : maxAgeSeconds(cookie.name, write.maxAge);
  const clears = maxAge !== undefined && maxAge <= 0n;
  const parts = [`${cookie.name}=${value}`, `Path=${cookie.path}`];
  if (cookie.domain !== null) parts.push(`Domain=${cookie.domain}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${clears ? 0n : maxAge}`);
  // A null expiry writes none: the cookie ends with the browser session.
  if (write.expires !== undefined && write.expires !== null) parts.push(`Expires=${expiresText(cookie.name, write.expires)}`);
  else if (clears) parts.push(`Expires=${CLEARED_EXPIRES}`);
  if (cookie.secure) parts.push("Secure");
  if (cookie.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${cookie.sameSite}`);
  if (cookie.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

function cookieValue(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw refused(name, "value", `evaluated to ${describe(value)}, and a cookie value must be text`);
  }
  if (!COOKIE_VALUE.test(value)) {
    throw refused(
      name,
      "value",
      "holds a character a cookie value cannot carry (a space, `\"`, `,`, `;`, `\\` or a non-ASCII " +
        "character); encode it, for example with base64url",
    );
  }
  return value;
}

function maxAgeSeconds(name: string, value: unknown): bigint {
  const nanos = isCelDuration(value)
    ? durationNanos(value)
    : typeof value === "string"
      ? durationNanosFromText(value)
      : undefined;
  if (typeof nanos !== "bigint") {
    throw refused(name, "maxAge", `evaluated to ${describe(value)}, and a max age must be a duration`);
  }
  // Whole seconds, rounded toward negative infinity.
  const seconds = nanos / NANOS_PER_SECOND;
  return nanos < 0n && nanos % NANOS_PER_SECOND !== 0n ? seconds - 1n : seconds;
}

function expiresText(name: string, value: unknown): string {
  const timestamp = isCelTimestamp(value) ? value : typeof value === "string" ? parseTimestamp(value) : undefined;
  if (!isCelTimestamp(timestamp)) {
    throw refused(name, "expires", `evaluated to ${describe(value)}, and an expiry must be a timestamp`);
  }
  return new Date(Number(timestampNanos(timestamp) / 1_000_000n)).toUTCString();
}

function refused(name: string, field: string, reason: string): InvokeError {
  return new InvokeError(
    ERR_COOKIE_VALUE_INVALID,
    `Cookie '${name}': its ${field} ${reason}.`,
    { cookie: name, field },
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "text that is not one";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
