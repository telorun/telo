/**
 * `url-text` — the plain encoding of `Telo.Url`, and how a URL value is built.
 *
 * A URL value carries its own type key and holds its MEMBERS, unescaped, as its own
 * entries: `scheme`, and where present `host`, `port`, `user`, `password`, `path` and
 * `query`. Its text is written from them by RFC 3986 component rules, so a password
 * holding `@`, `/` or `:` is escaped by the writer and never by an author.
 *
 * Reading is strict RFC 3986: a character a component does not admit raw must be
 * percent-encoded, a fragment is refused (a value has no member for one), and a query
 * key appears once. Writing is canonical — the scheme in lower case, every byte that is
 * not unreserved percent-encoded with upper-case hex (a path keeps its `/`), and the
 * query ordered by key — so one value has one text, which is what the typed frame
 * requires of a payload. The vectors at `sdk/value-types/encodings/url-text.json` pin
 * both directions, and the Rust codec runs the same file.
 *
 * Every refusal names what is wrong and never quotes the text or a member's value: a URL
 * routinely carries a password.
 */

import { CEL_VALUE_TYPE } from "@telorun/cel";

/** The type key a URL value carries — `Telo.Url`'s `binding`, in this runtime. */
export const URL_TYPE_KEY = "Telo.Url";

/** The members a URL value holds, unescaped. */
export interface UrlMembers {
  readonly scheme: string;
  readonly host?: string;
  readonly port?: bigint;
  readonly user?: string;
  readonly password?: string;
  readonly path?: string;
  readonly query?: Readonly<Record<string, string>>;
}

/** A URL value: its type key and its members. */
export type UrlValue = UrlMembers & { readonly [CEL_VALUE_TYPE]: typeof URL_TYPE_KEY };

/** The member names, in the order a refusal lists them. */
export const URL_MEMBER_NAMES = ["scheme", "host", "port", "user", "password", "path", "query"] as const;

/** What reading text or building from members answers. */
export type UrlReading = { readonly value: UrlValue } | { readonly refusal: string };

export function isUrlValue(value: unknown): value is UrlValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE] === URL_TYPE_KEY
  );
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const SUB_DELIMS = "!$&'()*+,;=";
const DIGITS = /^[0-9]+$/;
const LONE_SURROGATE = /\p{Cs}/u;

/** Whether `text` is an IPv6 address (RFC 4291 text form, no zone): eight groups of one
 *  to four hex digits, the last two of which may be a dotted IPv4 address, with at most
 *  one `::` standing for one or more zero groups. */
function isIpv6(text: string): boolean {
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (index === groups.length - 1 && group.includes(".")) {
      if (!isIpv4(group)) return false;
      count += 2;
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return false;
    count += 1;
  }
  return halves.length === 2 ? count <= 7 : count === 8;
}

function isIpv4(text: string): boolean {
  const octets = text.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/.test(octet));
}

const isUnreserved = (ch: string) => UNRESERVED.test(ch);
const isSubDelim = (ch: string) => SUB_DELIMS.includes(ch);
/** userinfo, reg-name: unreserved and sub-delims. */
const userOrHostChar = (ch: string) => isUnreserved(ch) || isSubDelim(ch);
/** A password may hold `:` raw — the first one separates it from the user. */
const passwordChar = (ch: string) => userOrHostChar(ch) || ch === ":";
/** pchar, plus the path's own separator. */
const pathChar = (ch: string) => userOrHostChar(ch) || ch === ":" || ch === "@" || ch === "/";
/** A query key or value: pchar, `/` and `?`, less the two separators the query map is read by. */
const queryChar = (ch: string) =>
  (isUnreserved(ch) || isSubDelim(ch) || ch === ":" || ch === "@" || ch === "/" || ch === "?") &&
  ch !== "&";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * The text a component's written form holds, or undefined when it holds a character the
 * component does not admit raw, a malformed escape, or bytes that are not UTF-8.
 */
function unescape(written: string, admits: (ch: string) => boolean): string | undefined {
  const bytes: number[] = [];
  for (let at = 0; at < written.length; ) {
    const ch = written[at]!;
    if (ch === "%") {
      const hex = written.slice(at + 1, at + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(parseInt(hex, 16));
      at += 3;
      continue;
    }
    if (!admits(ch)) return undefined;
    bytes.push(ch.charCodeAt(0));
    at += 1;
  }
  try {
    return decoder.decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/** A component's canonical written form: every byte that is not unreserved, escaped. */
function escape(text: string, keep: (ch: string) => boolean = isUnreserved): string {
  let out = "";
  for (const ch of text) {
    if (keep(ch)) {
      out += ch;
      continue;
    }
    for (const byte of encoder.encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function refused(refusal: string): UrlReading {
  return { refusal };
}

/** A URL value of exactly the members given, frozen with its query. */
function urlValue(members: UrlMembers): UrlValue {
  const value: Record<string | symbol, unknown> = { [CEL_VALUE_TYPE]: URL_TYPE_KEY, scheme: members.scheme };
  if (members.host !== undefined) value.host = members.host;
  if (members.port !== undefined) value.port = members.port;
  if (members.user !== undefined) value.user = members.user;
  if (members.password !== undefined) value.password = members.password;
  if (members.path !== undefined && members.path !== "") value.path = members.path;
  if (members.query !== undefined && Object.keys(members.query).length > 0) {
    const query = Object.create(null) as Record<string, string>;
    for (const key of Object.keys(members.query).sort(compareCodeUnits)) query[key] = members.query[key]!;
    value.query = Object.freeze(query);
  }
  return Object.freeze(value) as unknown as UrlValue;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Why `path` cannot stand beside an authority (or the lack of one), or nothing. */
function pathRefusal(path: string, authority: boolean): string | undefined {
  if (authority && path !== "" && !path.startsWith("/")) {
    return "its path must begin with '/' when it has a host";
  }
  if (!authority && path.startsWith("//")) {
    return "its path may not begin with '//' when it has no host";
  }
  return undefined;
}

/** The port a written port is, or why it is none. */
function portOf(digits: string): bigint | string {
  if (!DIGITS.test(digits)) return "its port is not a number from 1 to 65535";
  const port = BigInt(digits);
  return port >= 1n && port <= 65535n ? port : "its port is not a number from 1 to 65535";
}

/**
 * The URL value `text` writes, or why it writes none.
 */
export function readUrlText(text: string): UrlReading {
  if (LONE_SURROGATE.test(text)) return refused("it holds text that is not Unicode");
  if (text.includes("#")) return refused("it holds a fragment ('#'), which a Telo.Url does not carry");
  const colon = text.indexOf(":");
  if (colon < 0 || !SCHEME.test(text.slice(0, colon))) {
    return refused("it does not begin with a scheme ('postgres:', 'https:')");
  }
  const scheme = text.slice(0, colon).toLowerCase();
  let rest = text.slice(colon + 1);
  let query: Record<string, string> | undefined;
  const mark = rest.indexOf("?");
  if (mark >= 0) {
    const read = readQuery(rest.slice(mark + 1));
    if (typeof read === "string") return refused(read);
    query = read;
    rest = rest.slice(0, mark);
  }
  const members: { -readonly [K in keyof UrlMembers]: UrlMembers[K] } = { scheme };
  let path = rest;
  if (rest.startsWith("//")) {
    const end = rest.indexOf("/", 2);
    const authority = end < 0 ? rest.slice(2) : rest.slice(2, end);
    path = end < 0 ? "" : rest.slice(end);
    const reading = readAuthority(authority, members);
    if (reading !== undefined) return refused(reading);
  }
  const unescaped = unescape(path, pathChar);
  if (unescaped === undefined) {
    return refused("its path holds a character that must be percent-encoded, or a malformed escape");
  }
  const misplaced = pathRefusal(unescaped, members.host !== undefined);
  if (misplaced !== undefined) return refused(misplaced);
  members.path = unescaped;
  if (query !== undefined) members.query = query;
  return { value: urlValue(members) };
}

function readAuthority(
  authority: string,
  members: { -readonly [K in keyof UrlMembers]: UrlMembers[K] },
): string | undefined {
  let hostPort = authority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    const split = userinfo.indexOf(":");
    const user = unescape(split < 0 ? userinfo : userinfo.slice(0, split), userOrHostChar);
    const password = split < 0 ? undefined : unescape(userinfo.slice(split + 1), passwordChar);
    if (user === undefined || (split >= 0 && password === undefined)) {
      return "its user information holds a character that must be percent-encoded ('@', '/', '?' …), or a malformed escape";
    }
    members.user = user;
    if (password !== undefined) members.password = password;
  }
  let host: string;
  let port = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return "its host opens '[' and never closes it";
    host = hostPort.slice(1, close);
    if (!isIpv6(host)) return "its bracketed host is not an IPv6 address";
    const after = hostPort.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) return "its host is followed by something other than a port";
      port = after.slice(1);
    }
  } else {
    const split = hostPort.lastIndexOf(":");
    const written = split < 0 ? hostPort : hostPort.slice(0, split);
    if (split >= 0) port = hostPort.slice(split + 1);
    const unescaped = unescape(written, userOrHostChar);
    if (unescaped === undefined) {
      return "its host holds a character that must be percent-encoded, or a malformed escape";
    }
    if (unescaped.includes(":")) return "its host holds ':' outside brackets, which only an IPv6 address may";
    host = unescaped;
  }
  members.host = host;
  if (port !== "") {
    const read = portOf(port);
    if (typeof read === "string") return read;
    members.port = read;
  }
  return undefined;
}

function readQuery(written: string): Record<string, string> | string {
  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of written.split("&")) {
    if (pair === "") continue;
    const split = pair.indexOf("=");
    const key = unescape(split < 0 ? pair : pair.slice(0, split), queryChar);
    const value = split < 0 ? "" : unescape(pair.slice(split + 1), queryChar);
    if (key === undefined || value === undefined) {
      return "its query holds a character that must be percent-encoded, or a malformed escape";
    }
    if (key === "") return "its query holds an entry with no key";
    if (Object.prototype.hasOwnProperty.call(query, key)) return "its query repeats a key";
    query[key] = value;
  }
  return query;
}

/** The canonical text of a URL value. */
export function writeUrlText(value: UrlValue): string {
  let text = `${value.scheme}:`;
  if (value.host !== undefined) {
    text += "//";
    if (value.user !== undefined) {
      text += escape(value.user);
      if (value.password !== undefined) text += `:${escape(value.password)}`;
      text += "@";
    }
    text += value.host.includes(":") ? `[${value.host}]` : escape(value.host);
    if (value.port !== undefined) text += `:${value.port}`;
  }
  if (value.path !== undefined) text += escape(value.path, (ch) => isUnreserved(ch) || ch === "/");
  if (value.query !== undefined) {
    const keys = Object.keys(value.query).sort(compareCodeUnits);
    if (keys.length > 0) {
      text += `?${keys.map((key) => `${escape(key)}=${escape(value.query![key]!)}`).join("&")}`;
    }
  }
  return text;
}

/**
 * The URL value an object of members builds, or why it builds none. A member is a string,
 * the port an integer (a JSON number or a CEL int) and the query a map of strings to
 * strings; `scheme` is required, and the members of an authority — `user`, `password`,
 * `port` — need a `host` (an empty one is `host: ""`), a password a user.
 */
export function composeUrl(members: Readonly<Record<string, unknown>>): UrlReading {
  for (const name of Object.keys(members)) {
    if (!(URL_MEMBER_NAMES as readonly string[]).includes(name)) {
      return refused(`'${name}' is not one of its members (${URL_MEMBER_NAMES.join(", ")})`);
    }
  }
  for (const name of URL_MEMBER_NAMES) {
    const problem = urlMemberRefusal(name, members[name]);
    if (problem !== undefined) return refused(problem);
  }
  const scheme = members.scheme as string | undefined;
  if (scheme === undefined) return refused("it has no 'scheme' member");
  const host = members.host as string | undefined;
  for (const name of ["user", "password", "port"] as const) {
    if (members[name] !== undefined && host === undefined) {
      return refused(`its '${name}' member needs a 'host' (write host: "" for an empty one)`);
    }
  }
  if (members.password !== undefined && members.user === undefined) {
    return refused("its 'password' member needs a 'user' (write user: \"\" for an empty one)");
  }
  const path = (members.path as string | undefined) ?? "";
  const misplaced = pathRefusal(path, host !== undefined);
  if (misplaced !== undefined) return refused(misplaced);
  const port = members.port;
  return {
    value: urlValue({
      scheme: scheme.toLowerCase(),
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port: BigInt(port as number | bigint) }),
      ...(members.user === undefined ? {} : { user: members.user as string }),
      ...(members.password === undefined ? {} : { password: members.password as string }),
      path,
      ...(members.query === undefined ? {} : { query: members.query as Record<string, string> }),
    }),
  };
}

/**
 * Why one member's value cannot stand in a URL, or nothing when it can — or is absent. A
 * value of the wrong type is named by type, never quoted.
 */
export function urlMemberRefusal(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  switch (name) {
    case "port": {
      const integer =
        typeof value === "bigint" ? value : typeof value === "number" && Number.isInteger(value) ? BigInt(value) : undefined;
      if (integer === undefined || integer < 1n || integer > 65535n) {
        return "its 'port' member is not an integer from 1 to 65535";
      }
      return undefined;
    }
    case "query": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "its 'query' member is not a map of strings to strings";
      }
      const prototype = Object.getPrototypeOf(value) as object | null;
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
        return "its 'query' member is not a map of strings to strings";
      }
      for (const [key, held] of Object.entries(value)) {
        if (key === "") return "its 'query' member holds an entry with no key";
        if (typeof held !== "string" || LONE_SURROGATE.test(held) || LONE_SURROGATE.test(key)) {
          return "its 'query' member is not a map of strings to strings";
        }
      }
      return undefined;
    }
    default: {
      if (!(URL_MEMBER_NAMES as readonly string[]).includes(name)) return undefined;
      if (typeof value !== "string" || LONE_SURROGATE.test(value)) return `its '${name}' member is not text`;
      if (name === "scheme" && !SCHEME.test(value)) {
        return "its 'scheme' member is not a scheme (a letter, then letters, digits, '+', '-' or '.')";
      }
      if (name === "host" && value.includes(":") && !isIpv6(value)) {
        return "its 'host' member holds ':' and is not an IPv6 address (written without brackets)";
      }
      return undefined;
    }
  }
}
