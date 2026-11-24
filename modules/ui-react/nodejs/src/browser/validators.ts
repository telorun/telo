import { changeKey } from "./address-wire.js";

/** Methods that carry the kept validator as `If-Match`. */
const CONDITIONAL = new Set(["PATCH", "PUT", "DELETE"]);
/** Methods whose success answer is the record at the request's own path. */
const RECORD_ANSWERS = new Set(["GET", "PATCH", "PUT"]);
/** Paths kept at once; the least recently used is dropped past it. */
const KEPT_PATHS = 2000;

/**
 * The `ETag` of the last read or write answer at each resolved request path
 * (encoded, app-relative, query left out), which a later `PATCH`, `PUT` or
 * `DELETE` to that path carries as `If-Match`. A server that sends no `ETag`
 * leaves nothing kept, so nothing is sent, and neither does a weak one (`W/…`),
 * which `If-Match` never matches. Held to `conformance/merge-patch.json`.
 */
export class Validators {
  private readonly held = new Map<string, string>();

  constructor(private readonly limit = KEPT_PATHS) {}

  /** Take what an answer says: a record answer's `ETag` replaces the kept one (its absence drops it), a removal or a missing record drops it, a refusal keeps it until a read replaces it. */
  answered(method: string, path: string, status: number, etag: string | null | undefined): void {
    const key = changeKey(path);
    if (key === undefined) return;
    if (status >= 200 && status < 300 && RECORD_ANSWERS.has(method.toUpperCase())) {
      if (etag && !etag.startsWith("W/")) this.keep(key, etag);
      else this.held.delete(key);
    } else if ((status >= 200 && status < 300 && method.toUpperCase() === "DELETE") || status === 404) this.held.delete(key);
  }

  /** The `If-Match` a request carries: the kept validator of its path, for a write only. */
  ifMatch(method: string, path: string): string | undefined {
    if (!CONDITIONAL.has(method.toUpperCase())) return undefined;
    const key = changeKey(path);
    const etag = key === undefined ? undefined : this.held.get(key);
    if (key !== undefined && etag !== undefined) this.keep(key, etag);
    return etag;
  }

  private keep(key: string, etag: string): void {
    this.held.delete(key);
    this.held.set(key, etag);
    for (const oldest of this.held.keys()) {
      if (this.held.size <= this.limit) break;
      this.held.delete(oldest);
    }
  }
}
