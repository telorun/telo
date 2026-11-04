import type { Binding } from "./row-binding.js";

/** An address or request target as a renderer receives it, every member present. */
export interface AddressSpec {
  path: Binding;
  pathParams: Record<string, Binding>;
  queryParams: Record<string, Binding>;
}

/** Why an address does not resolve: `parameter` names the path parameter whose
 *  value holds nothing, or `path` when the whole address is unusable. */
export class AddressUnresolvedError extends Error {
  readonly code = "ERR_UI_ADDRESS_UNRESOLVED";
  readonly data: { parameter: string };

  constructor(parameter: string, reason: string) {
    super(`The address does not resolve: ${reason}.`);
    this.name = "AddressUnresolvedError";
    this.data = { parameter };
  }
}

const APP_RELATIVE = /^\/([^/\\\u0000-\u001f\u007f][^\u0000-\u001f\u007f]*)?$/;
const ABSOLUTE = /^(https:\/\/|http:\/\/|mailto:)/;

/** Whether `text` is an address a link or request may follow: under the
 *  application's mount, or an `https:`, `http:` or `mailto:` address. */
export const isAddress = (text: string): boolean => APP_RELATIVE.test(text) || ABSOLUTE.test(text);

const encoder = new TextEncoder();
const HEX = "0123456789ABCDEF";

function encoded(text: string, keep: (byte: number) => boolean, space?: string): string {
  let out = "";
  for (const byte of encoder.encode(text)) {
    if (byte === 0x20 && space !== undefined) out += space;
    else if (keep(byte)) out += String.fromCharCode(byte);
    else out += `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
  }
  return out;
}

const isAlphanumeric = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

/** One path segment: only RFC 3986's unreserved characters stay, and a segment
 *  that is `.` or `..` is encoded too so it cannot move the path. */
function segment(text: string): string {
  if (text === "." || text === "..") return text.replaceAll(".", "%2E");
  return encoded(text, (byte) => isAlphanumeric(byte) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e);
}

/** A query name or value, as `application/x-www-form-urlencoded` writes it. */
const formEncoded = (text: string): string =>
  encoded(text, (byte) => isAlphanumeric(byte) || byte === 0x2a || byte === 0x2d || byte === 0x2e || byte === 0x5f, "+");

function pathValue(name: string, value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  throw new AddressUnresolvedError(name, `path parameter '${name}' holds ${value === "" ? "an empty string" : value == null ? "nothing" : "a value that is neither text nor an integer"}`);
}

function queryValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return JSON.stringify(value);
  return undefined;
}

/** A template's text with its `{name}` segments filled. The query and fragment
 *  of a template hold no variable and are kept as written. */
function filled(template: string, params: Record<string, unknown>): string {
  const tail = template.search(/[?#]/);
  const head = tail < 0 ? template : template.slice(0, tail);
  const rest = tail < 0 ? "" : template.slice(tail);
  const authority = /^(https:\/\/|http:\/\/)[^/]*/.exec(head)?.[0] ?? (head.startsWith("mailto:") ? "mailto:" : "");
  const body = head.slice(authority.length);
  const pieces = authority === "mailto:" ? [body] : body.split("/");
  const out = pieces.map((piece) => {
    const name = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(piece)?.[1];
    return name === undefined ? piece : segment(pathValue(name, params[name]));
  });
  return authority + out.join(authority === "mailto:" ? "" : "/") + rest;
}

/**
 * The text an address resolves to, `read` giving the value a binding names. A
 * literal path is a template whose `{name}` segments are the values of
 * `pathParams`, each percent-encoded as one segment; a path read from data is
 * used as it is. `queryParams` are appended in declaration order, after the
 * path's own query and before its fragment. The result is held to the address
 * rule. Throws {@link AddressUnresolvedError} when it does not resolve.
 */
export function expandAddress(address: AddressSpec, read: (binding: Binding) => unknown): string {
  const path = address.path;
  let text: string;
  if ("value" in path) {
    if (typeof path.value !== "string") throw new AddressUnresolvedError("path", "the path is not text");
    const params: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(address.pathParams)) params[name] = read(binding);
    text = filled(path.value, params);
  } else {
    const value = read(path);
    if (typeof value !== "string") throw new AddressUnresolvedError("path", "the path holds no text");
    text = value;
  }
  const pairs: string[] = [];
  for (const [name, binding] of Object.entries(address.queryParams)) {
    const value = read(binding);
    for (const one of Array.isArray(value) ? value : [value]) {
      const written = queryValue(one);
      if (written !== undefined) pairs.push(`${formEncoded(name)}=${formEncoded(written)}`);
    }
  }
  if (pairs.length > 0) {
    const fragment = text.indexOf("#");
    const head = fragment < 0 ? text : text.slice(0, fragment);
    text = `${head}${head.includes("?") ? "&" : "?"}${pairs.join("&")}${fragment < 0 ? "" : text.slice(fragment)}`;
  }
  if (!isAddress(text)) throw new AddressUnresolvedError("path", "the result is not an address under the application's mount or an https, http or mailto address");
  return text;
}
