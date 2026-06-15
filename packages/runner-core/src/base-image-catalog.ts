/**
 * A base-image catalog backed by the Docker Hub repository-tags API. A runner
 * advertises the resolved tag list as an `enum` on its session `image` field so
 * the editor renders a base-image picker, and validates a chosen image against
 * the same list server-side — the runner is the source of truth, so a non-editor
 * client can't widen the allowed set.
 *
 * The list is fetched at startup and on a refresh interval, cached in memory,
 * and degrades gracefully: when Docker Hub is unreachable the catalog still
 * serves the configured default (always present), so the runner boots and a
 * session can still start on the default image.
 *
 * Free of runner specifics — it takes only a repository, a default ref, and a
 * tag filter — but the tag source is specifically Docker Hub's registry API
 * (`hub.docker.com/v2`); a base on another registry (GHCR, a private registry)
 * can't be enumerated or digest-resolved here. The Docker registry the kubelet
 * pulls from is a separate concern; this resolves the *menu* of base images, not
 * pull auth.
 */

/** A composable predicate set narrowing a repository's tag list to the offered
 *  menu. Named flags cover the common cases; `include`/`exclude` are the regex
 *  escape hatch for everything else. */
export interface TagFilter {
  /** Keep only `MAJOR.MINOR.PATCH[-variant]` tags — drops moving tags (`latest`,
   *  `0`, `0.30`) and their variants (`latest-slim`, `0-slim`). */
  pinnedOnly?: boolean;
  /** Drop commit-hash tags (`sha-<hex>` or a bare hex string). */
  excludeSha?: boolean;
  /** Drop semver prereleases (`0.30.1-rc.1`, `…-alpha`). Variant suffixes like
   *  `-slim` / `-rust-1.95.0` are NOT prereleases and are kept. */
  excludePrerelease?: boolean;
  /** A tag must match at least one of these to be kept. */
  include?: RegExp[];
  /** A tag matching any of these is dropped. */
  exclude?: RegExp[];
}

export interface BaseImageCatalogOptions {
  /** `namespace/repository`, e.g. `telorun/node`. */
  repository: string;
  /** Always-present default ref — the pre-selected option and the
   *  Docker-Hub-unreachable fallback, e.g. `telorun/node:latest-slim`. */
  defaultRef: string;
  filter?: TagFilter;
  /** Cap the advertised list to this many tags (newest first). Default 20. */
  limit?: number;
  /** Background refresh cadence in ms. Default 1h. */
  refreshIntervalMs?: number;
  /** Upper bound on tags pulled from Docker Hub before filtering. Default 200. */
  maxTagsScanned?: number;
  /** Per-request timeout for a Docker Hub call, in ms. Default 10s. */
  requestTimeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const SHA_TAG = /^(?:sha-)?[0-9a-f]{7,}$/i;
const PINNED_TAG = /^\d+\.\d+\.\d+(?:[-.].*)?$/;
const PRERELEASE_CORE = /^\d+\.\d+\.\d+-(.+)$/;
/** First `-` identifier on a pinned tag that marks it a prerelease rather than a
 *  build variant (`-slim`, `-rust-*`). */
const PRERELEASE_TOKENS = new Set([
  "rc",
  "alpha",
  "beta",
  "pre",
  "preview",
  "next",
  "canary",
  "dev",
  "nightly",
  "snapshot",
]);

function isShaTag(tag: string): boolean {
  return SHA_TAG.test(tag);
}

function isPrerelease(tag: string): boolean {
  const m = PRERELEASE_CORE.exec(tag);
  if (!m) return false;
  const firstId = m[1].split(/[-.]/, 1)[0].toLowerCase();
  return PRERELEASE_TOKENS.has(firstId);
}

/** Apply a {@link TagFilter} to a tag list, preserving input order. Pure — the
 *  unit-testable core of the catalog. */
export function filterTags(tags: string[], filter: TagFilter = {}): string[] {
  return tags.filter((tag) => {
    if (filter.excludeSha && isShaTag(tag)) return false;
    if (filter.pinnedOnly && !PINNED_TAG.test(tag)) return false;
    if (filter.excludePrerelease && isPrerelease(tag)) return false;
    if (filter.include && filter.include.length > 0 && !filter.include.some((re) => re.test(tag))) {
      return false;
    }
    if (filter.exclude && filter.exclude.some((re) => re.test(tag))) return false;
    return true;
  });
}

function splitRepository(repository: string): [namespace: string, repo: string] {
  const slash = repository.indexOf("/");
  // A bare name (no slash) is a Docker official image under `library/`.
  if (slash < 0) return ["library", repository];
  return [repository.slice(0, slash), repository.slice(slash + 1)];
}

function unique(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Fetch a repository's tags from Docker Hub, newest first, bounded by
 * `maxTagsScanned`. Paginates the `/v2/repositories/{ns}/{repo}/tags` endpoint
 * and sorts by `last_updated` descending so the cap keeps the most recent tags
 * regardless of the API's page ordering. Throws on a network/HTTP error — the
 * caller decides whether a failure degrades to default-only.
 */
async function fetchRepoTags(
  repository: string,
  maxTagsScanned: number,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const [namespace, repo] = splitRepository(repository);
  const collected: Array<{ name: string; lastUpdated: string }> = [];
  let url: string | null =
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/` +
    `${encodeURIComponent(repo)}/tags?page_size=100`;

  while (url && collected.length < maxTagsScanned) {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(
        `Docker Hub tags request for '${repository}' failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      next?: string | null;
      results?: Array<{ name?: string; last_updated?: string }>;
    };
    for (const r of body.results ?? []) {
      if (typeof r.name === "string") {
        collected.push({ name: r.name, lastUpdated: r.last_updated ?? "" });
      }
    }
    url = body.next ?? null;
  }

  collected.sort((a, b) =>
    a.lastUpdated < b.lastUpdated ? 1 : a.lastUpdated > b.lastUpdated ? -1 : 0,
  );
  return collected.map((c) => c.name);
}

/**
 * Parse a Docker image reference into the Docker Hub coordinates needed to look
 * up its digest, or `null` when the ref points at a non-Docker-Hub registry.
 * Handles the `library/` shorthand, optional `docker.io` host, and an already
 * `@sha256:`-pinned digest (carried through verbatim).
 */
export function parseDockerHubRef(
  ref: string,
): { namespace: string; repo: string; tag: string; digest?: string } | null {
  let rest = ref;
  let digest: string | undefined;
  const at = ref.indexOf("@");
  if (at >= 0) {
    digest = ref.slice(at + 1);
    rest = ref.slice(0, at);
  }

  // A first path segment with a `.`/`:` (or `localhost`) is a registry host.
  const firstSlash = rest.indexOf("/");
  const firstPart = firstSlash >= 0 ? rest.slice(0, firstSlash) : "";
  if (firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost") {
    const hubHosts = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
    if (!hubHosts.has(firstPart)) return null;
    rest = rest.slice(firstSlash + 1);
  }

  // `rest` is now `name[:tag]`; the tag is the segment after a colon that isn't
  // inside the path (i.e. after the last `/`).
  const lastColon = rest.lastIndexOf(":");
  const lastSlash = rest.lastIndexOf("/");
  let name = rest;
  let tag = "latest";
  if (lastColon > lastSlash) {
    name = rest.slice(0, lastColon);
    tag = rest.slice(lastColon + 1);
  }

  const slash = name.indexOf("/");
  return {
    namespace: slash >= 0 ? name.slice(0, slash) : "library",
    repo: slash >= 0 ? name.slice(slash + 1) : name,
    tag,
    digest,
  };
}

/**
 * Resolve a Docker Hub image ref's CURRENT manifest digest. A moving tag
 * (`latest-slim`) maps to a new digest once a new version is published, so a
 * build that folds this into its cache key detects that the base moved and
 * rebuilds. An already `@sha256:`-pinned ref returns its digest without a
 * network call. Returns `undefined` for a non-Docker-Hub ref (not an error —
 * resolution simply doesn't apply) or when a Hub request fails. A genuine
 * request failure is reported to `onError` rather than swallowed, so an operator
 * whose Hub calls persistently fail (auth / network / rate-limit) gets a signal
 * instead of an unexplained "always reuses the cached image".
 */
export async function resolveTagDigest(
  ref: string,
  opts: {
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    onError?: (err: unknown) => void;
  } = {},
): Promise<string | undefined> {
  const parsed = parseDockerHubRef(ref);
  if (!parsed) return undefined;
  if (parsed.digest) return parsed.digest;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url =
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(parsed.namespace)}/` +
    `${encodeURIComponent(parsed.repo)}/tags/${encodeURIComponent(parsed.tag)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000),
    });
    if (!res.ok) {
      opts.onError?.(new Error(`Docker Hub tag request for '${ref}' failed: ${res.status} ${res.statusText}`));
      return undefined;
    }
    const body = (await res.json()) as { digest?: string; images?: Array<{ digest?: string }> };
    return body.digest ?? body.images?.find((i) => i.digest)?.digest ?? undefined;
  } catch (err) {
    opts.onError?.(err);
    return undefined;
  }
}

export class BaseImageCatalog {
  private readonly repository: string;
  private readonly defaultRef: string;
  private readonly filter: TagFilter;
  private readonly limit: number;
  private readonly refreshIntervalMs: number;
  private readonly maxTagsScanned: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Filtered tags (bare, newest first); empty until the first refresh. */
  private tags: string[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: BaseImageCatalogOptions) {
    this.repository = opts.repository;
    this.defaultRef = opts.defaultRef;
    this.filter = opts.filter ?? {};
    this.limit = opts.limit ?? 20;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 60 * 60 * 1000;
    this.maxTagsScanned = opts.maxTagsScanned ?? 200;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The advertised image refs: the default first, then the filtered tags. */
  current(): string[] {
    const refs = this.tags.map((tag) => `${this.repository}:${tag}`);
    return unique([this.defaultRef, ...refs]);
  }

  /** Whether `ref` is offered by this catalog (server-side allowlist check). */
  isAllowed(ref: string): boolean {
    return this.current().includes(ref);
  }

  /** Refetch and re-filter the tag list. Throws on a fetch/HTTP failure. */
  async refresh(): Promise<void> {
    const tags = await fetchRepoTags(
      this.repository,
      this.maxTagsScanned,
      this.requestTimeoutMs,
      this.fetchImpl,
    );
    this.tags = filterTags(tags, this.filter).slice(0, this.limit);
  }

  /** Begin periodic background refresh. Refresh failures are surfaced to
   *  `onError` rather than swallowed; the last good list keeps serving. */
  start(onError?: (err: unknown) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refresh().catch((err) => onError?.(err));
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
