/**
 * Reading and writing a version where it lives, touching nothing else.
 *
 * Each write finds the one scalar and splices over its span, so a bump is a
 * one-line diff rather than a re-serialized file that reorders keys or reflows
 * text. A location names a file and, for JSON, YAML or TOML, an RFC 6901
 * pointer into it; with no pointer the file is read by the handler registered
 * for its name, or — for any other file — as a plain version file holding the
 * version alone.
 */

import { isScalar, parseDocument, type Scalar } from "yaml";
import type { AdapterRegistry, VersionLocationSpec } from "./adapter.js";

export class VersionFileError extends Error {}

/** Replace `[start, end)` of `text`. */
export function spliceText(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/** The pointer's reference tokens, unescaped. */
export function pointerTokens(pointer: string, where: string): string[] {
  if (!pointer.startsWith("/")) {
    throw new VersionFileError(`${where}: '${pointer}' is not a JSON pointer; it must start with '/'.`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Format = "json" | "yaml" | "toml";

function formatOf(file: string): Format | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  return undefined;
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** The version a location holds, or `undefined` when it holds none. */
export function readVersionAt(
  location: VersionLocationSpec,
  text: string,
  where: string,
  adapters: AdapterRegistry,
): string | undefined {
  if (location.pointer !== undefined) return readPointer(text, location, where);
  const handler = adapters.handlerFor(baseName(location.file));
  if (handler) return handler.read(text, where);
  refuseStructured(location, where);
  const version = text.trim();
  return version === "" || version.includes("\n") ? undefined : version;
}

/** `text` rewritten so the location holds `version`. Throws when the location
 *  holds no version to rewrite: skipping it would ship files that disagree. */
export function writeVersionAt(
  location: VersionLocationSpec,
  text: string,
  version: string,
  where: string,
  adapters: AdapterRegistry,
): string {
  if (location.pointer !== undefined) return writePointer(text, location, version, where);
  const handler = adapters.handlerFor(baseName(location.file));
  if (handler) {
    const written = handler.write(text, version, where);
    if (written === undefined) {
      throw new VersionFileError(`${where} carries no version to write.`);
    }
    return written;
  }
  refuseStructured(location, where);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n")) {
    throw new VersionFileError(
      `${where} is read as a plain version file, but it does not hold a single version line.`,
    );
  }
  const start = text.indexOf(trimmed);
  return spliceText(text, start, start + trimmed.length, version);
}

function refuseStructured(location: VersionLocationSpec, where: string): void {
  const format = formatOf(location.file);
  if (format) {
    throw new VersionFileError(
      `${where} is ${format.toUpperCase()}, and no handler here reads a version from a file of ` +
        `that name. Name the version with { file, pointer }.`,
    );
  }
}

function readPointer(text: string, location: VersionLocationSpec, where: string): string | undefined {
  const tokens = pointerTokens(location.pointer!, where);
  const format = formatOf(location.file);
  if (format === "toml") return tomlString(text, tokens, where)?.value;
  if (format === undefined) throw unpointable(where);
  const node = documentScalar(text, tokens, where);
  return node && typeof node.value === "string" ? node.value : undefined;
}

function writePointer(
  text: string,
  location: VersionLocationSpec,
  version: string,
  where: string,
): string {
  const tokens = pointerTokens(location.pointer!, where);
  const format = formatOf(location.file);
  if (format === "toml") {
    const found = tomlString(text, tokens, where);
    if (!found) throw new VersionFileError(`${where} holds no string at ${location.pointer}.`);
    return spliceText(text, found.start, found.end, `${found.quote}${version}${found.quote}`);
  }
  if (format === undefined) throw unpointable(where);
  const node = documentScalar(text, tokens, where);
  if (!node || typeof node.value !== "string") {
    throw new VersionFileError(`${where} holds no string at ${location.pointer}.`);
  }
  return spliceScalar(text, node, version, where);
}

function unpointable(where: string): VersionFileError {
  return new VersionFileError(`${where}: a pointer reads only a JSON, YAML or TOML file.`);
}

/** The scalar node at `tokens` of a JSON or YAML document. */
export function documentScalar(text: string, tokens: readonly string[], where: string): Scalar | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new VersionFileError(`${where} cannot be parsed: ${doc.errors[0]!.message}`);
  }
  const node = doc.getIn(tokens, true);
  return isScalar(node) ? node : undefined;
}

/** Splice `version` over a scalar node, re-quoted in the author's own style. */
export function spliceScalar(text: string, node: Scalar, version: string, where: string): string {
  const range = node.range;
  if (!range) throw new VersionFileError(`${where}: the version scalar carries no source range.`);
  const [start, end] = range;
  const source = text.slice(start, end);
  const quoted = source.startsWith('"')
    ? JSON.stringify(version)
    : source.startsWith("'")
      ? `'${version.replace(/'/g, "''")}'`
      : /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) && !source.includes("\n")
        ? version
        : undefined;
  if (quoted === undefined) {
    throw new VersionFileError(
      `${where}: the version is written as '${source}', which cannot be rewritten in place. ` +
        `Write it as a plain or quoted scalar on one line.`,
    );
  }
  return spliceText(text, start, end, quoted);
}

interface TomlString {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/**
 * A quoted string at `tokens` of a TOML document — the last token a key, the
 * rest the table header holding it (none: the root table). Scanned rather than
 * parsed, for the shape version files are written in: a `[table]` header and a
 * `key = "value"` line. A dotted key or an inline table is refused by not being
 * found, never guessed at.
 */
export function tomlString(text: string, tokens: readonly string[], where: string): TomlString | undefined {
  if (tokens.length === 0) throw new VersionFileError(`${where}: the pointer names no key.`);
  const table = tokens.slice(0, -1);
  const key = tokens[tokens.length - 1]!;
  const headers = /^[ \t]*(\[\[?)([^\]\n]*)\]\]?[ \t]*(?:#.*)?$/gm;

  let bodyStart = table.length === 0 ? 0 : -1;
  let bodyEnd = text.length;
  for (let header = headers.exec(text); header; header = headers.exec(text)) {
    if (bodyStart >= 0) {
      bodyEnd = header.index;
      break;
    }
    if (header[1] === "[" && sameTablePath(header[2]!, table)) {
      bodyStart = header.index + header[0].length;
    }
  }
  if (bodyStart < 0) return undefined;

  const body = text.slice(bodyStart, bodyEnd);
  const keyPattern = new RegExp(
    `^([ \\t]*(?:${escapeRegExp(key)}|"${escapeRegExp(key)}")[ \\t]*=[ \\t]*)("[^"\\n]*"|'[^'\\n]*')[ \\t]*(?:#.*)?$`,
    "m",
  );
  const entry = keyPattern.exec(body);
  if (!entry) return undefined;
  const start = bodyStart + entry.index + entry[1]!.length;
  const literal = entry[2]!;
  return { value: literal.slice(1, -1), start, end: start + literal.length, quote: literal[0]! };
}

function sameTablePath(header: string, table: readonly string[]): boolean {
  const parts = header.split(".").map((part) => part.trim().replace(/^"(.*)"$/, "$1"));
  return parts.length === table.length && parts.every((part, i) => part === table[i]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
