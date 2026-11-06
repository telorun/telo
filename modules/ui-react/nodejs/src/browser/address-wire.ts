import { readBinding, type Binding } from "./bindings.js";

/** An address or request target as the page document carries it, every member present. */
export interface AddressWire {
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

const isAddress = (text: string): boolean => APP_RELATIVE.test(text) || ABSOLUTE.test(text);

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

const isAlphanumeric = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

/** One path segment as an address writes it. */
export function segment(text: string): string {
  if (text === "." || text === "..") return text.replaceAll(".", "%2E");
  return encoded(text, (byte) => isAlphanumeric(byte) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e);
}

const formEncoded = (text: string): string =>
  encoded(text, (byte) => isAlphanumeric(byte) || byte === 0x2a || byte === 0x2d || byte === 0x2e || byte === 0x5f, "+");

function pathValue(name: string, value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  throw new AddressUnresolvedError(
    name,
    `path parameter '${name}' holds ${value === "" ? "an empty string" : value == null ? "nothing" : "a value that is neither text nor an integer"}`,
  );
}

function queryValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return JSON.stringify(value);
  return undefined;
}

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
 * The text an address resolves to, `read` giving the value a binding names: the
 * browser twin of `@telorun/ui`'s expansion, held to the same vectors
 * (`conformance/addresses.json`). Throws {@link AddressUnresolvedError} when it
 * does not resolve.
 */
export function expandAddress(address: AddressWire, read: (binding: Binding) => unknown): string {
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

/** Whether a wire value is an address (a record with `path`) rather than a string. */
export const isAddressWire = (value: unknown): value is AddressWire =>
  value !== null && typeof value === "object" && "path" in value && "pathParams" in value;

const reported = new Set<string>();

/** What an address resolved to: its text, or why it did not. */
export type Resolution = { ok: true; address: string } | { ok: false; error: AddressUnresolvedError };

const readFrom = (roots: Readonly<Record<string, unknown>>) => (binding: Binding) => {
  const read = readBinding(binding, roots);
  return read.present ? read.value : undefined;
};

/** Whether any binding of an address reads the named root. */
export const addressReads = (address: AddressWire | undefined, root: string): boolean =>
  address !== undefined &&
  [address.path, ...Object.values(address.pathParams), ...Object.values(address.queryParams)].some((binding) => "root" in binding && binding.root === root);

/**
 * A request target over the roots in scope: an address that stays under the
 * application's mount. A failure is reported once in the console.
 */
export function resolveRequest(address: AddressWire, roots: Readonly<Record<string, unknown>>, where: string): Resolution {
  try {
    const text = expandAddress(address, readFrom(roots));
    if (!text.startsWith("/")) throw new AddressUnresolvedError("path", "a request target stays under the application's mount");
    return { ok: true, address: text };
  } catch (error) {
    if (!(error instanceof AddressUnresolvedError)) throw error;
    reportUnresolved(error, where);
    return { ok: false, error };
  }
}

/** Report an unresolved address once per distinct message. */
function reportUnresolved(error: AddressUnresolvedError, where: string): void {
  const line = `${error.code}: ${where}: ${error.message} (parameter '${error.data.parameter}')`;
  if (reported.has(line)) return;
  reported.add(line);
  console.error(line);
}

/**
 * Where an address leads over the roots in scope: its text, or nothing when it
 * does not resolve, which is reported once in the console.
 */
export function resolveAddress(address: AddressWire, roots: Readonly<Record<string, unknown>>, where: string): string | undefined {
  try {
    return expandAddress(address, readFrom(roots));
  } catch (error) {
    if (!(error instanceof AddressUnresolvedError)) throw error;
    reportUnresolved(error, where);
    return undefined;
  }
}

/**
 * The key readers and writers meet at: an app-relative address's path, query
 * and fragment dropped, kept as encoded. Nothing for an address that leaves the
 * application.
 */
export function changeKey(address: string): string | undefined {
  if (!address.startsWith("/")) return undefined;
  const end = address.search(/[?#]/);
  return end < 0 ? address : address.slice(0, end);
}

const segmentsOf = (path: string): string[] => (path === "/" ? [] : path.slice(1).split("/"));

/** Whether `pattern`'s segments cover `path`'s: `*` one non-empty segment, `**` any number, none included. */
function segmentsMatch(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") return path.some((_, skipped) => segmentsMatch(rest, path.slice(skipped))) || segmentsMatch(rest, []);
  if (path.length === 0) return false;
  if (head === "*" ? path[0] === "" : head !== path[0]) return false;
  return segmentsMatch(rest, path.slice(1));
}

/** Which readers a refresh reads again: the path it resolved to, and whether its `*` / `**` segments are wildcards. */
export interface Refresh {
  path: string;
  wildcard: boolean;
}

const isWildcardSegment = (text: string): boolean => text === "*" || text === "**";

/**
 * A refresh entry over the roots in scope: the change key it resolves to, a
 * pattern only when its path is a literal template holding a `*` or `**`
 * segment (a value a `{name}` filled is encoded, so it never is one, and a path
 * read from data is exact). Nothing for an entry that does not resolve or leaves
 * the application.
 */
export function resolveRefresh(address: AddressWire, roots: Readonly<Record<string, unknown>>, where: string): Refresh | undefined {
  const text = resolveAddress(address, roots, where);
  const path = text === undefined ? undefined : changeKey(text);
  if (path === undefined) return undefined;
  return { path, wildcard: "value" in address.path && segmentsOf(path).some(isWildcardSegment) };
}

/** Whether a refresh reads again the readers of change key `key` (their encoded app-relative path, query left out). Held to `conformance/refreshes.json`. */
export function refreshCovers(refresh: Refresh, key: string): boolean {
  return refresh.wildcard ? segmentsMatch(segmentsOf(refresh.path), segmentsOf(key)) : refresh.path === key;
}

/** Where the viewer is, under the application's mount. */
export interface CurrentLocation {
  path: string;
  search: string;
}

/** A query as a map from each key to its values in order, the renderer's own `_telo*` parameters set aside. */
function ownQuery(search: string): Map<string, string[]> {
  const query = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    if (name.startsWith("_telo")) continue;
    query.set(name, [...(query.get(name) ?? []), value]);
  }
  return query;
}

/**
 * Whether an address leads to where the viewer is: an app-relative address whose
 * path equals the current path exactly, the fragment ignored, and whose query
 * equals the current one with every `_telo*` parameter set aside — key order
 * free, each key's values an ordered list, an absent key absent. Held to
 * `conformance/current-location.json`.
 */
export function isCurrentAddress(address: string, location: CurrentLocation): boolean {
  if (!APP_RELATIVE.test(address)) return false;
  const fragment = address.indexOf("#");
  const head = fragment < 0 ? address : address.slice(0, fragment);
  const mark = head.indexOf("?");
  const path = mark < 0 ? head : head.slice(0, mark);
  if (path !== location.path) return false;
  const wanted = ownQuery(mark < 0 ? "" : head.slice(mark));
  const held = ownQuery(location.search);
  if (wanted.size !== held.size) return false;
  for (const [name, values] of wanted) {
    const other = held.get(name);
    if (other === undefined || other.length !== values.length || other.some((value, index) => value !== values[index])) return false;
  }
  return true;
}
