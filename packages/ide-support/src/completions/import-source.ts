import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";

/** Maximum ref hits to surface in a single completion request. Keeps the
 *  popover scannable when a broad `q=` query matches many registered refs
 *  (the hub already caps `/refs` server-side; this is a client backstop). */
const REF_LIMIT = 50;

/** Caps the number of directory entries we probe with `hasManifest` per
 *  request. Each probe is a host-side filesystem stat; the popover would not
 *  show more than ~50 entries anyway, so probing further only adds latency. */
const PATH_PROBE_LIMIT = 50;

/**
 * Completions for an import source — an `imports:` map entry on a module doc
 * (either the scalar shorthand `Alias: <src>` or the `source:` under the
 * object form).
 *
 * Branches by prefix shape:
 *   ""                         → relative dirs under the manifest dir, plus `./` / `../` seeds.
 *   "./..", "../", "/..."      → subdirs of the typed path (any subdir; existing manifest gets a hint).
 *   "<word>", "oci://…"        → hub ref autocomplete (fuzzy substring over registered refs).
 *   "<ref>@<partial>"          → version list for that ref.
 *   "http(s)://", "file://"    → no suggestions (opaque URLs the author types verbatim).
 *
 * `oci://` is deliberately NOT opaque: without an `@` it routes to the ref
 * search below, whose query is the whole typed prefix — so the hub fuzzy-matches
 * `oci://ghcr.io/aws/telo-s3` as readily as a bare `s3`.
 *
 * `valueStartColumn` is forwarded onto every result so the host can replace
 * the whole typed value, not just the trailing word (Monaco / VSCode word
 * boundaries don't cross `/` or `@`).
 */
export async function importSourceCompletions(
  prefix: string,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter | undefined,
): Promise<CompletionResult[]> {
  if (!adapter) return [];

  if (
    prefix.startsWith("http://") ||
    prefix.startsWith("https://") ||
    prefix.startsWith("file://")
  ) {
    return [];
  }

  const isRelativeShape =
    prefix === "" || prefix.startsWith(".") || prefix.startsWith("/");
  if (isRelativeShape) {
    return relativePathCompletions(prefix, valueStartColumn, adapter);
  }

  // The version (or `@sha256:` digest) is the trailing `@`-segment, so split on
  // the LAST `@` — a digest-pinned ref keeps everything before it as the ref.
  const atIdx = prefix.lastIndexOf("@");
  if (atIdx > 0) {
    return versionCompletions(prefix, atIdx, valueStartColumn, adapter);
  }

  return refSearchCompletions(prefix, valueStartColumn, adapter);
}

async function relativePathCompletions(
  prefix: string,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter,
): Promise<CompletionResult[]> {
  // Empty prefix → seed `./` and `../` so the user gets traction; otherwise
  // we'd return an unfiltered dump of the manifest directory which is rarely
  // what the user wants for an import source.
  if (prefix === "") {
    return [
      {
        label: "./",
        kind: "folder",
        insertText: "./",
        sortText: "0_./",
        replaceFromColumn: valueStartColumn,
      },
      {
        label: "../",
        kind: "folder",
        insertText: "../",
        sortText: "0_../",
        replaceFromColumn: valueStartColumn,
      },
    ];
  }

  // Split the typed prefix at the last `/`: everything up to it is the
  // directory we list, the trailing chunk is what the user is filtering on.
  const lastSlash = prefix.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
  const namePart = lastSlash >= 0 ? prefix.slice(lastSlash + 1) : prefix;

  // If the user hasn't typed a slash yet (e.g. just `.` or `..`), nothing
  // to list — let them keep typing until they pass `/`.
  if (dirPart === "") return [];

  const dirs = await adapter.listDirectories(dirPart);
  const matches = dirs
    .filter((name) => name.startsWith(namePart))
    .sort()
    .slice(0, PATH_PROBE_LIMIT);

  // Probe every candidate in parallel. Sequential `await` here makes a wide
  // directory (e.g. `modules/` with dozens of children) feel sluggish — Promise.all
  // fans the host's filesystem stats out concurrently so total latency is bounded
  // by the slowest single probe rather than their sum.
  return Promise.all(
    matches.map(async (name) => {
      const fullPath = dirPart + name;
      const isModule = await adapter.hasManifest(fullPath);
      return {
        label: name,
        kind: "folder",
        detail: isModule ? "telo module" : "folder",
        insertText: fullPath,
        filterText: fullPath,
        replaceFromColumn: valueStartColumn,
        // Modules sort above plain folders so they surface first when the user
        // is browsing a `modules/` tree mixed with non-Telo siblings.
        sortText: isModule ? `0_${name}` : `1_${name}`,
      } satisfies CompletionResult;
    }),
  );
}

async function refSearchCompletions(
  prefix: string,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter,
): Promise<CompletionResult[]> {
  // The whole typed prefix is the fuzzy query — the hub matches it as a
  // substring over each registered ref, so no client-side splitting is needed
  // (and `oci://ghcr.io/aws/telo-s3` matches without mangling the `//`).
  const hits = await adapter.searchRefs(prefix);

  return hits.slice(0, REF_LIMIT).map((m) => {
    // Seed the pinned `ref@latestVersion` so the completion is directly usable;
    // the author can still narrow the version afterwards (the `@` re-triggers
    // version completion).
    const id = m.latestVersion ? `${m.ref}@${m.latestVersion}` : m.ref;
    const name = refDisplayName(m.ref);
    // Lead the label with the module name so the interesting part isn't cut off
    // behind the transport/host boilerplate (`oci://ghcr.io/telorun/…`). The
    // full ref moves to `detail`, and `insertText`/`filterText` stay the ref so
    // acceptance still inserts it and a fully-typed ref still filters.
    return {
      label: m.latestVersion ? `${name}@${m.latestVersion}` : name,
      kind: "module",
      detail: m.description ?? m.ref,
      documentation: m.description ? m.ref : undefined,
      insertText: id,
      filterText: id,
      replaceFromColumn: valueStartColumn,
    };
  });
}

/** The `org/name` tail of a location ref: its last two path segments, with the
 *  transport scheme (`oci://`, `https://`, …) and registry host dropped.
 *  `oci://ghcr.io/telorun/telo-console` → `telorun/telo-console`; `std/console`
 *  → `std/console`. Falls back to fewer segments (or the whole ref) when there
 *  aren't two. */
function refDisplayName(ref: string): string {
  const withoutScheme = ref.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = withoutScheme.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || ref;
}

async function versionCompletions(
  prefix: string,
  atIdx: number,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter,
): Promise<CompletionResult[]> {
  const ref = prefix.slice(0, atIdx);
  const partialVersion = prefix.slice(atIdx + 1);
  if (ref === "") return [];

  const versions = await adapter.listVersionsForRef(ref);

  const matches = versions.filter((v) => v.startsWith(partialVersion));
  return matches.map((version, idx) => {
    const id = `${ref}@${version}`;
    // The ref is already typed and visible on the line, so the label is just the
    // version — no point repeating the full ref on every row. `insertText` /
    // `filterText` stay the full id so acceptance replaces the whole value and
    // the already-typed ref prefix keeps the item in the filtered set.
    return {
      label: version,
      kind: "value",
      detail: idx === 0 ? "latest" : undefined,
      insertText: id,
      filterText: id,
      replaceFromColumn: valueStartColumn,
      // Preserve the hub's ordering (newest first) so the latest version is
      // suggested at the top regardless of lexical comparison.
      sortText: String(idx).padStart(4, "0"),
    };
  });
}
