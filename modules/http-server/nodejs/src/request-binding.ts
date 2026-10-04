import { isCelRecord } from "@telorun/sdk";

/**
 * One of the transport's own bags — the query string, the path parameters — as a map in the
 * CEL value domain.
 *
 * `request` is a CEL binding, so every member of it has to BE a CEL value, and a map a host
 * hands over is a plain object: the member-read seam resolves a string key against an
 * object whose prototype is `Object.prototype` or `null`, and answers "this value holds no
 * members" for anything else — never a host property read, which is what stops a computed
 * key (`request.query[k]`) from ever reaching a prototype, a method or `constructor`.
 *
 * Fastify's bags are not plain objects. Its query parser (`fast-querystring`) builds each
 * one as `new Empty()`, whose prototype is a null-prototype object — prototype-free data by
 * intent, and a container the engine cannot read: `request.query.page` failed with "this
 * value holds no members" and `'k' in request.query` with "in was handed a value of no CEL
 * type", so every handler reading the query string answered 500.
 *
 * Copied by its OWN entries, so nothing inherited crosses, and returned by identity when it
 * is already in the domain — a body parsed from JSON is, and costs nothing here.
 */
export function requestBag(bag: unknown): Record<string, unknown> {
  if (bag === null || bag === undefined) return {};
  if (isCelRecord(bag)) return bag as Record<string, unknown>;
  if (typeof bag !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(bag)) out[key] = (bag as Record<string, unknown>)[key];
  return out;
}
