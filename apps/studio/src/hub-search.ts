/** Client for the telo hub's module search — `GET {hub}/search/modules?q=`.
 *  Powers the "Add import" dialog's autocomplete: the hub is the single source
 *  of importable modules (no per-registry fan-out). */

import type { ModuleVersion } from "@telorun/ide-support";
import { HubClient } from "@telorun/language-host";

export type { ModuleVersion };

/** Public hub, mirroring the CLI's `TELO_HUB_URL` default. A self-hosted setup
 *  overrides it via the `hubUrl` setting. */
export const DEFAULT_HUB_URL = "https://telo.sh";

export function resolveHubUrl(hubUrl: string | undefined): string {
  return (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, "");
}

/** One kind hit surfaced by the fused lexical/vector search. */
export interface HubMatchedKind {
  /** `kind` declares a kind, `instance` is a ready-made instance. Absent on a
   *  hub that predates instance hits. */
  entry?: "kind" | "instance" | "application";
  /** What an importer writes after its alias — the kind or the instance. */
  name?: string;
  /** The kind the entry is, or instantiates. */
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

/** What a result is titled: the module's own name, else the last segment of its ref. */
export function hubHitTitle(hit: HubModuleHit): string {
  if (hit.module.name) return hit.module.name;
  const tail = hit.module.ref.split("/").pop() ?? hit.module.ref;
  return tail.split("@")[0].replace(/\.ya?ml$/, "") || hit.module.ref;
}

export interface HubModuleHit {
  module: {
    ref: string;
    version: string;
    /** The module's declared `metadata.name`; empty or absent on an older hub. */
    name?: string;
    description: string;
    repository: string;
    license: string;
    /** The built-in vocabulary — its kinds need no import and it cannot be one. */
    builtin?: boolean;
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
  return (data.hits ?? []).filter((h) => h.module?.ref && !h.module.builtin);
}

/** A hit's matches as chips: each kind once, each ready-made instance by its
 *  own name. */
export function matchChips(hit: HubModuleHit): { name: string; instance: boolean }[] {
  const seen = new Set<string>();
  const out: { name: string; instance: boolean }[] = [];
  for (const match of hit.matchedKinds) {
    const instance = match.entry === "instance";
    const name = match.name ?? match.kind;
    const key = `${instance}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, instance });
  }
  return out;
}

/** The hub's version lists, through the one reader every editor host shares.
 *
 *  `listVersions(baseRef)` answers every version the hub tracks, newest first —
 *  the hub's ordering is authoritative, so index 0 is the latest. `baseRef` must
 *  be the bare registered ref (`oci://ghcr.io/telorun/console`); the hub matches
 *  it exactly. This is the only version source the editor has: a browser cannot
 *  speak the OCI protocol, so `tags/list` is out of reach and the hub's ingest
 *  is what holds the list. A module the hub does not track answers `[]`; any
 *  other failure rejects naming the hub, so a caller can tell an outage or a
 *  misconfigured hub from a module that genuinely has no versions. */
export function hubClient(hubUrl: string | undefined): HubClient {
  return new HubClient({ url: () => resolveHubUrl(hubUrl) });
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
