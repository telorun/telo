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

export interface ModuleRef {
  ref: string;
  version: string;
  description: string;
}

export interface MatchedKind {
  kind: string;
  capability: string;
  description: string;
  score: number;
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
  exportedKinds: string[];
  exportedResources: string[];
}

export type SearchResult =
  | { ok: true; hits: ModuleHit[] }
  | { ok: false; error: string };

/** Module-first search over the hub's federated index. An empty query is valid
 *  and returns a browse list, so the page has something to show on first load. */
export async function searchModules(query: string, signal?: AbortSignal): Promise<SearchResult> {
  let res: Response;
  try {
    res = await fetch(`${HUB_API}/search/modules?q=${encodeURIComponent(query)}`, {
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
  return { ok: true, hits: hits as ModuleHit[] };
}

/** Every version the hub has tracked for a ref, newest first. The detail pane
 *  shows more than a search hit carries, which only names the latest version. */
export async function fetchModuleVersions(ref: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${HUB_API}/module/versions?ref=${encodeURIComponent(ref)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const versions = (data as { versions?: unknown }).versions;
  return Array.isArray(versions) ? (versions as string[]) : [];
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
