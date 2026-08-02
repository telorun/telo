/** Client for the telo hub's module search — `GET {hub}/search/modules?q=`.
 *  Powers the "Add import" dialog's autocomplete: the hub is the single source
 *  of importable modules (no per-registry fan-out). */

/** Public hub, mirroring the CLI's `TELO_HUB_URL` default. A self-hosted setup
 *  overrides it via the `hubUrl` setting. */
export const DEFAULT_HUB_URL = "https://telo.sh";

export function resolveHubUrl(hubUrl: string | undefined): string {
  return (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, "");
}

/** One kind hit surfaced by the fused lexical/vector search. */
export interface HubMatchedKind {
  kind: string;
  capability: string;
  description: string;
  score: number;
}

/** A `/search/modules` hit — a module grouped with the kinds that matched. */
/** One facet value: the label the module's author wrote, and the slug the hub
 *  derived from it (what a filter matches). */
export interface HubCategory {
  slug: string;
  label: string;
}

export interface HubModuleHit {
  module: {
    ref: string;
    version: string;
    description: string;
    repository: string;
    license: string;
    /** Declared categories. Absent on a hub that predates the facet. */
    categories?: HubCategory[];
  };
  score: number;
  matchedKinds: HubMatchedKind[];
  exportedKinds: string[];
  exportedResources: string[];
}

interface SearchModulesResponse {
  query: string;
  hits: HubModuleHit[];
}

/** Searches the hub for modules matching `query`. Throws an actionable error on
 *  any transport/parse failure so the dialog can distinguish an outage or a
 *  misconfigured hub from a genuinely empty result (an empty array). An aborted
 *  request rethrows the `AbortError` so the caller can ignore stale results. */
export async function searchHubModules(
  hubUrl: string | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<HubModuleHit[]> {
  const base = resolveHubUrl(hubUrl);
  const url = `${base}/search/modules?q=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(
      `Could not reach the telo hub at ${base}: ${errText(err)}. Check the hub URL in settings (it must allow CORS).`,
    );
  }
  if (!res.ok) {
    throw new Error(`Hub search failed at ${base}: HTTP ${res.status} ${res.statusText}.`);
  }
  const data = (await res.json()) as SearchModulesResponse;
  return (data.hits ?? []).filter((h) => h.module?.ref);
}

interface ModuleVersionsResponse {
  versions?: string[];
}

/** Every version the hub tracks for `baseRef`, newest first — the hub's
 *  ordering is authoritative, so index 0 is the latest.
 *
 *  `baseRef` must be the bare registered ref (`oci://ghcr.io/acme/telo-s3`,
 *  `oci://ghcr.io/telorun/console`); the hub matches it exactly. This is the only version source
 *  the editor has: a browser cannot speak the OCI protocol, so `tags/list` is
 *  out of reach and the hub's ingest is what holds the version list.
 *
 *  Returns `[]` for a module the hub does not track (404). Any other failure
 *  throws, so a caller can tell an outage or a misconfigured hub from a module
 *  that genuinely has no versions. */
export async function fetchHubVersions(
  hubUrl: string | undefined,
  baseRef: string,
): Promise<string[]> {
  const base = resolveHubUrl(hubUrl);
  const url = `${base}/module/versions?ref=${encodeURIComponent(baseRef)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new Error(
      `Could not reach the telo hub at ${base}: ${errText(err)}. Check the hub URL in settings (it must allow CORS).`,
    );
  }
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `Hub version lookup for ${baseRef} failed at ${base}: HTTP ${res.status} ${res.statusText}.`,
    );
  }
  const data = (await res.json()) as ModuleVersionsResponse;
  return (data.versions ?? []).filter((v): v is string => typeof v === "string");
}

/** The pinned import source for a hit: `<ref>@<version>` (e.g.
 *  `oci://ghcr.io/acme/telo-s3@1.2.0`, `acme/console@0.9.0`). */
export function importSourceForHit(hit: HubModuleHit): string {
  const { ref, version } = hit.module;
  return version ? `${ref}@${version}` : ref;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
