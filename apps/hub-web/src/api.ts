/** The hub's dynamic API origin. Defaults to the production read/register plane
 *  (telo.sh); point at the docker-compose hub for local dev via
 *  VITE_HUB_API=http://localhost:8040. */
export const HUB_API = import.meta.env.VITE_HUB_API ?? "https://telo.sh";

export type RegisterResult =
  | { ok: true; ref: string }
  | { ok: false; error: string };

/** POST a module ref to the hub's open /register verb. The hub validates the
 *  ref resolves to a real Telo module and, on success, indexes it for tracking;
 *  a bad ref comes back as a 400 with an inline reason. */
export async function registerModule(ref: string): Promise<RegisterResult> {
  let res: Response;
  try {
    res = await fetch(`${HUB_API}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }

  const data: unknown = await res.json().catch(() => ({}));
  if (res.ok && isRegistered(data)) {
    return { ok: true, ref: data.ref };
  }
  return { ok: false, error: errorMessage(data, res.status) };
}

/** One facet value. `label` is what the module's author wrote; `slug` is what
 *  the hub derived from it and what filtering and URLs use. */
export interface Category {
  slug: string;
  label: string;
}

/** Which kernels can load something, and what its controllers are written in.
 *
 *  Telo is polyglot, so this is a capability of the thing rather than trivia:
 *  a kind whose only controller is JavaScript cannot run on the Rust kernel.
 *  `portable` means it declares no controllers at all and therefore has no
 *  kernel constraint — recorded as a flag rather than by listing today's
 *  kernels, which would go stale the day a third one ships.
 *
 *  On a module, `runtimes` is every kernel with at least partial reach and
 *  `full` the subset covering every kind, so `console` reads as Node (full),
 *  Rust (partial). A kind carries no `full` — it either runs or it does not. */
export interface RuntimeSupport {
  runtimes: string[];
  full?: string[];
  languages: string[];
  portable: boolean;
}

/** A module's replacement is another module, addressed as an import source. */
export interface ModuleDeprecation {
  reason: string;
  replacedBy: string;
}

/** A kind's replacement is another kind, resolved by the hub through the
 *  declaring manifest's imports — so it is a target that can be linked. An
 *  empty `ref` with a non-empty `kind` names a kernel built-in. */
export interface KindDeprecation {
  reason: string;
  replacedBy: { kind: string; ref: string };
}

export interface ModuleRef {
  ref: string;
  version: string;
  /** The module's declared `metadata.name` — what its author calls it, and what
   *  the kind registry and diagnostics print. Display identity only: it is not a
   *  locator (the `ref` is) and it is not unique across the federation, which is
   *  why the ref is always shown alongside it. Absent from a hub that predates
   *  this field, hence the ref-tail fallback at every call site. */
  name?: string;
  description: string;
  /** Declared categories. Absent from a hub that predates the facet. */
  categories?: Category[];
  /** The fields below are absent from a hub that predates them — this app
   *  deploys independently of the backend, so every one is optional. */
  repository?: string;
  license?: string;
  homepage?: string;
  publisher?: string;
  deprecated?: ModuleDeprecation;
  runtime?: RuntimeSupport;
}

/** One kind a module exports. `KindInfo` on the module page and `MatchedKind` in
 *  a search hit are the same thing seen from two angles — a match adds a
 *  relevance score, which is the only reason the two lists stay separate. */
export interface KindInfo {
  kind: string;
  capability: string;
  abstract?: boolean;
  description: string;
  extends?: { kind: string; ref: string };
  runtime?: RuntimeSupport;
  deprecated?: KindDeprecation;
}

export interface MatchedKind extends KindInfo {
  score: number;
}

/** A ready-made singleton instance a library exports, referenced by an importer
 *  as `!ref <Alias>.<name>`.
 *
 *  `kind` and `description` come from the declaring doc in the exporting module,
 *  so both are empty for a re-export — that doc belongs to another module
 *  entirely. `declared` is the verbatim entry, which is what tells the two
 *  apart (`Other.thing` vs `thing`). */
export interface ExportedResource {
  name: string;
  kind: string;
  description: string;
  declared: string;
}

/** One module-first search hit. The export lists come from the index, so a
 *  result card shows the module's whole public surface with no second fetch.
 *  That surface is two lists: `exportedKinds` (kinds an importer may
 *  instantiate) and `exportedResources` (ready-made singleton instances
 *  referenced as `!ref <Alias>.<name>`) — a library may offer either or both. */
export interface ModuleHit {
  module: ModuleRef;
  score: number;
  matchedKinds: MatchedKind[];
  /** Full detail for every exported kind, not just the matched ones — which is
   *  what lets the preview panel describe any of them without a second request. */
  exportedKinds: KindInfo[];
  exportedResources: ExportedResource[];
}

export type SearchResult =
  | { ok: true; hits: ModuleHit[]; total: number }
  | { ok: false; error: string };

/** Page size for the module list. The hub caps `limit` at 100 and reports the
 *  pre-limit `total`, so browsing a category shows how much is left rather than
 *  stopping silently. */
export const PAGE_SIZE = 30;

/** Module-first search over the hub's federated index. Browsing is the same
 *  call with an empty query and a category: the hub degrades to an unranked
 *  listing, so the page has something to show on first load and the facet
 *  narrows it without a separate endpoint. */
export async function searchModules(
  query: string,
  category: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query, limit: String(PAGE_SIZE) });
  if (category) params.set("category", category);

  let res: Response;
  try {
    res = await fetch(`${HUB_API}/search/modules?${params}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: errorMessage(data, res.status) };
  const hits = (data as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return { ok: false, error: "unexpected response from the hub" };
  const total = (data as { total?: unknown }).total;
  return {
    ok: true,
    hits: hits as ModuleHit[],
    total: typeof total === "number" ? total : hits.length,
  };
}

/** One entry of the category facet: the slug to filter by, the label to print,
 *  and how many modules are in it. Several authored labels can normalize to one
 *  slug, in which case the hub picks the most-declared one. */
export interface CategoryFacet {
  category: string;
  label: string;
  modules: number;
}

/** The categories that exist, derived by the hub from what modules declare —
 *  there is no fixed vocabulary to hardcode here. A failure yields an empty
 *  list: the filter is an optional narrowing, so search still works without it. */
export async function fetchCategories(signal?: AbortSignal): Promise<CategoryFacet[]> {
  const res = await fetch(`${HUB_API}/categories`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const categories = (data as { categories?: unknown }).categories;
  return Array.isArray(categories) ? (categories as CategoryFacet[]) : [];
}

/** Every version the hub has tracked for a ref, newest first. The detail pane
 *  shows more than a search hit carries, which only names the latest version.
 *
 *  The route returns `{version, integrity}` per entry — the import pin an editor
 *  writes on upgrade. Only the names are wanted here, so the pin is dropped at
 *  the boundary rather than carried into a list that never renders it. */
export async function fetchModuleVersions(ref: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${HUB_API}/module/versions?ref=${encodeURIComponent(ref)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const versions = (data as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return [];
  return versions
    .map((entry) => (entry as { version?: unknown }).version)
    .filter((v): v is string => typeof v === "string");
}

export interface ModuleInfo extends ModuleRef {
  latestVersion: string;
  name: string;
  transport: string;
  /** The import pin for this version, or empty when nothing can hash the ref. */
  integrity: string;
}

export interface ModulePage {
  module: ModuleInfo;
  kinds: KindInfo[];
  exportedResources: ExportedResource[];
  versions: string[];
}

export type ModulePageResult =
  | { ok: true; page: ModulePage }
  | { ok: false; error: string };

/** Everything a module page renders, in one call.
 *
 *  Distinct from a search hit: keyed by ref rather than ranked, able to serve a
 *  non-latest version, and carrying the full kind list. A page built from
 *  `/search/modules` would need three round trips and still could not address
 *  an older version. */
export async function fetchModule(
  ref: string,
  version: string,
  signal?: AbortSignal,
): Promise<ModulePageResult> {
  const params = new URLSearchParams({ ref });
  if (version) params.set("version", version);

  let res: Response;
  try {
    res = await fetch(`${HUB_API}/module?${params}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: errorMessage(data, res.status) };
  const page = data as Partial<ModulePage>;
  // Check the two fields the page cannot render without, rather than trusting
  // the cast: everything else has a sensible empty rendering, but a missing ref
  // or version would produce a broken import snippet and a version picker that
  // navigates nowhere — a wrong page rather than an error.
  const module = page.module;
  if (typeof module?.ref !== "string" || typeof module?.version !== "string") {
    return { ok: false, error: "unexpected response from the hub" };
  }
  return {
    ok: true,
    page: {
      module,
      kinds: Array.isArray(page.kinds) ? page.kinds : [],
      exportedResources: Array.isArray(page.exportedResources) ? page.exportedResources : [],
      versions: Array.isArray(page.versions)
        ? page.versions.filter((v): v is string => typeof v === "string")
        : [],
    },
  };
}

function isRegistered(data: unknown): data is { registered: true; ref: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { registered?: unknown }).registered === true &&
    typeof (data as { ref?: unknown }).ref === "string"
  );
}

function errorMessage(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null) {
    const { error, message } = data as { error?: unknown; message?: unknown };
    if (typeof error === "string" && error) return error;
    if (typeof message === "string" && message) return message;
  }
  return `request failed (${status})`;
}
