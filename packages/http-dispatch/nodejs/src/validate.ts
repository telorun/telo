import type { CatchEntry, ContentEntry, ReturnEntry } from "./schema.js";

type EntryList = ReturnEntry[] | CatchEntry[];

type ResourceLike = {
  routes?: Array<{
    request?: { path?: string };
    returns?: ReturnEntry[];
    catches?: CatchEntry[];
  }>;
};

/** Rejects `Content-Type` (case-insensitive) anywhere in entry-level or
 *  per-MIME `headers:` blocks. The matched `content[mime]` map key IS the
 *  canonical Content-Type — declaring it again in `headers:` would either be
 *  redundant or contradictory.
 *
 *  Defense-in-depth: the rule is expressible as JSON Schema `propertyNames`,
 *  but the runtime check is cheap and gives a clearer error message than
 *  AJV's generic `propertyNames` failure. */
export function validateNoContentTypeHeader(resource: ResourceLike): void {
  for (const route of resource.routes ?? []) {
    const path = route.request?.path ?? "<unknown>";
    for (const list of [route.returns, route.catches] as Array<EntryList | undefined>) {
      if (!list) continue;
      for (const entry of list) {
        rejectContentTypeIn(entry.headers, `${path} entry-level headers`);
        if (!entry.content) continue;
        for (const [mime, c] of Object.entries(entry.content)) {
          rejectContentTypeIn((c as ContentEntry).headers, `${path} content[${mime}].headers`);
        }
      }
    }
  }
}

function rejectContentTypeIn(
  headers: Record<string, string> | undefined,
  where: string,
): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      throw new Error(
        `Http.Api: '${where}' declares 'Content-Type' — forbidden. The matched content[mime] map key is the only Content-Type source.`,
      );
    }
  }
}

/** Rejects `when:` CEL expressions on stream-mode `returns:` entries that
 *  reference the root `result` identifier. The handler result in stream mode
 *  is an unconsumed `Stream<...>`; iterating it to evaluate the predicate
 *  would either fail or consume the stream before bytes flow to the response.
 *  References to `request.*` are fine — they don't touch the stream.
 *
 *  This stays as a runtime check because expressing it as per-branch
 *  `x-telo-context` in a `oneOf`-on-`mode` schema would require a
 *  discriminator-aware variant of `extractContextsFromSchema` in the
 *  analyzer — out of scope for this package. Token-aware so it doesn't
 *  false-positive on benign expressions like `request.headers["x-result"]`. */
export function validateStreamWhenDoesNotReferenceResult(resource: ResourceLike): void {
  for (const route of resource.routes ?? []) {
    const path = route.request?.path ?? "<unknown>";
    for (const entry of route.returns ?? []) {
      if (entry.mode !== "stream" || !entry.when) continue;
      const source =
        typeof entry.when === "string"
          ? entry.when
          : (entry.when as { source?: string })?.source ?? "";
      if (referencesRootIdentifier(source, "result")) {
        throw new Error(
          `Http.Api: '${path}' returns entry with mode: stream — 'when:' references the root 'result' identifier. ` +
            `The handler result is an unconsumed Stream and cannot be inspected from CEL. ` +
            `Reference only request.* in stream-mode 'when:' predicates.`,
        );
      }
    }
  }
}

/** True if `source` contains a free-standing CEL identifier `target` —
 *  i.e. it appears as a root identifier (not preceded by `.`, not part of
 *  another word) and not inside a single- or double-quoted string literal.
 *  Token-aware so members like `request.result_count` and string literals
 *  like `'my result'` don't trigger a match. */
function referencesRootIdentifier(source: string, target: string): boolean {
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      const word = source.slice(i, j);
      let k = i - 1;
      while (k >= 0 && /\s/.test(source[k]!)) k--;
      const isMember = k >= 0 && source[k] === ".";
      if (word === target && !isMember) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
}
