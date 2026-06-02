import type { CompletionResult, IdeEnvironmentAdapter } from "../types.js";

/** Maximum registry hits to surface in a single completion request.
 *  Keeps the popover scannable when a broad `q=` query matches the catalog. */
const REGISTRY_LIMIT = 50;

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
 *   "<word>"                   → registry search by free-text.
 *   "<ns>/<name>@<partial>"    → version list for that module.
 *   "http(s)://", "file://"    → no suggestions (opaque URLs).
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

  const atIdx = prefix.indexOf("@");
  if (atIdx > 0) {
    return versionCompletions(prefix, atIdx, valueStartColumn, adapter);
  }

  return registrySearchCompletions(prefix, valueStartColumn, adapter);
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

async function registrySearchCompletions(
  prefix: string,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter,
): Promise<CompletionResult[]> {
  // The registry's `q` filter ILIKEs against name / namespace / description —
  // it doesn't know about the `<namespace>/<name>` shape. Once the user has
  // typed a `/`, sending the literal `std/htt` as `q` matches nothing because
  // the slash is not in any of those columns. Split here so `q` carries just
  // the bit that looks like a name, and apply the namespace constraint
  // client-side.
  const slashIdx = prefix.indexOf("/");
  const namespacePart = slashIdx >= 0 ? prefix.slice(0, slashIdx) : "";
  const namePart = slashIdx >= 0 ? prefix.slice(slashIdx + 1) : prefix;

  const hits = await adapter.searchRegistry(namePart);
  const filtered = namespacePart
    ? hits.filter((h) => h.namespace.startsWith(namespacePart))
    : hits;

  return filtered.slice(0, REGISTRY_LIMIT).map((m) => {
    const id = `${m.namespace}/${m.name}@${m.version}`;
    return {
      label: id,
      kind: "module",
      detail: m.description ?? "registry module",
      insertText: id,
      filterText: id,
      replaceFromColumn: valueStartColumn,
    };
  });
}

async function versionCompletions(
  prefix: string,
  atIdx: number,
  valueStartColumn: number,
  adapter: IdeEnvironmentAdapter,
): Promise<CompletionResult[]> {
  const beforeAt = prefix.slice(0, atIdx);
  const partialVersion = prefix.slice(atIdx + 1);
  const slashIdx = beforeAt.indexOf("/");
  if (slashIdx <= 0 || slashIdx === beforeAt.length - 1) return [];

  const namespace = beforeAt.slice(0, slashIdx);
  const name = beforeAt.slice(slashIdx + 1);
  const versions = await adapter.listRegistryVersions(namespace, name);

  const matches = versions.filter((v) => v.startsWith(partialVersion));
  return matches.map((version, idx) => {
    const id = `${namespace}/${name}@${version}`;
    return {
      label: id,
      kind: "value",
      detail: idx === 0 ? "latest" : `v${version}`,
      insertText: id,
      filterText: id,
      replaceFromColumn: valueStartColumn,
      // Preserve registry's ordering (newest first) so the latest version is
      // suggested at the top regardless of lexical comparison.
      sortText: String(idx).padStart(4, "0"),
    };
  });
}
