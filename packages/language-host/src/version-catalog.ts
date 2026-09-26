import { comparePlainVersions, parsePlainVersion } from "./plain-version.js";

/** The npm package every telo version publishes its engine as. */
export const ENGINE_PACKAGE = "@telorun/language-server";
/** Its full package document — the abbreviated install document drops the
 *  custom `teloEditorProtocol` field the catalog is built from. */
export const ENGINE_REGISTRY_DOCUMENT = "https://registry.npmjs.org/@telorun/language-server";

/** Where one offered version's engine is fetched from, and what it must hash to. */
export interface CatalogEntry {
  version: string;
  tarball: string;
  /** npm's `dist.integrity`, `sha512-<base64>`. */
  integrity: string;
}

/** Why a published version is not offered. */
export type UnofferedReason =
  /** Published before engines declared a protocol — below the protocol floor. */
  | "below-protocol-floor"
  /** Speaks a protocol generation this host does not. */
  | "unspoken-generation"
  | "prerelease"
  | "deprecated"
  /** Carries no `sha512` integrity to verify a download against. */
  | "unverifiable";

/** What the host keeps between sessions. */
export interface StoredCatalog {
  /** Newest first. */
  offered: CatalogEntry[];
  unoffered: Record<string, UnofferedReason>;
}

/** Host-supplied storage for the last catalog read from the registry. */
export interface CatalogCache {
  read(): Promise<StoredCatalog | undefined>;
  write(catalog: StoredCatalog): Promise<void>;
}

/** A catalog as read: from the registry now, from the last cached read, or
 *  nothing at all. */
export interface CatalogReading extends StoredCatalog {
  /** `bundled` when neither the registry nor a cache answered: the host then
   *  knows the engine it ships and nothing else. */
  source: "registry" | "cache" | "bundled";
  /** Why the registry could not be read, when `source` is not `registry`. */
  failure?: string;
}

export interface VersionCatalog extends CatalogReading {
  /** The identity of the engine the host ships, as its handshake reported it —
   *  always offered, whatever the registry says. Absent while the bundled
   *  engine has not identified itself (it has not answered, or it failed). */
  bundled?: string;
}

/** How long the registry read may take before the cached catalog stands in. */
export const CATALOG_READ_TIMEOUT_MS = 15_000;

interface RegistryVersion {
  teloEditorProtocol?: unknown;
  deprecated?: unknown;
  dist?: { tarball?: unknown; integrity?: unknown };
}

/** The offered and unoffered versions of a registry package document, for a
 *  host speaking the protocol generations in `speaks`. */
export function readRegistryDocument(document: unknown, speaks: readonly number[]): StoredCatalog {
  const versions = (document as { versions?: Record<string, RegistryVersion> } | null)?.versions ?? {};
  const offered: CatalogEntry[] = [];
  const unoffered: Record<string, UnofferedReason> = {};
  for (const [version, meta] of Object.entries(versions)) {
    const tarball = meta?.dist?.tarball;
    const integrity = meta?.dist?.integrity;
    if (!parsePlainVersion(version)) unoffered[version] = "prerelease";
    else if (typeof meta?.teloEditorProtocol !== "number") unoffered[version] = "below-protocol-floor";
    else if (!speaks.includes(meta.teloEditorProtocol)) unoffered[version] = "unspoken-generation";
    else if (meta.deprecated !== undefined && meta.deprecated !== false) unoffered[version] = "deprecated";
    else if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      unoffered[version] = "unverifiable";
    } else offered.push({ version, tarball, integrity });
  }
  offered.sort((a, b) => comparePlainVersions(b.version, a.version));
  return { offered, unoffered };
}

/** The last catalog the host cached, or nothing — read without the network. */
export async function readCachedCatalog(cache: CatalogCache, failure?: string): Promise<CatalogReading> {
  const cached = await cache.read();
  if (cached) return { ...cached, source: "cache", ...(failure ? { failure } : {}) };
  return { offered: [], unoffered: {}, source: "bundled", ...(failure ? { failure } : {}) };
}

/**
 * The versions this host can offer: the registry's, else the last cached read,
 * else nothing but the bundled engine — never a guess. A registry document that
 * does not exist yet (404) is an answer, an empty one; any other failure — an
 * error, an answer that is not the document, no answer within `timeoutMs` — is
 * the offline path, recorded in `failure`. A fresh read the cache then fails to
 * store is still the answer: the failure goes to `warn`.
 */
export async function loadCatalog(options: {
  speaks: readonly number[];
  cache: CatalogCache;
  fetch?: typeof globalThis.fetch;
  documentUrl?: string;
  timeoutMs?: number;
  warn(message: string): void;
}): Promise<CatalogReading> {
  const url = options.documentUrl ?? ENGINE_REGISTRY_DOCUMENT;
  let stored: StoredCatalog;
  try {
    stored = await withinTimeout(
      readRegistry(url, options.speaks, options.fetch ?? globalThis.fetch),
      options.timeoutMs ?? CATALOG_READ_TIMEOUT_MS,
      `${url} did not answer within ${Math.round((options.timeoutMs ?? CATALOG_READ_TIMEOUT_MS) / 1000)} s`,
    );
  } catch (error) {
    return readCachedCatalog(options.cache, error instanceof Error ? error.message : String(error));
  }
  try {
    await options.cache.write(stored);
  } catch (error) {
    options.warn(
      `telo: the engine catalog read from ${url} could not be cached for offline use: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ...stored, source: "registry" };
}

async function readRegistry(url: string, speaks: readonly number[], fetchImpl: typeof globalThis.fetch): Promise<StoredCatalog> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return { offered: [], unoffered: {} };
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status} ${response.statusText}`);
  let document: unknown;
  try {
    document = await response.json();
  } catch (error) {
    throw new Error(`${url} answered with something that is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readRegistryDocument(document, speaks);
}

function withinTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Every version the host can run, newest first: the offered ones plus the
 *  bundled one. Of two with equal precedence (a published `X` and a bundled
 *  `X+unreleased`) the published one comes first. */
export function knownVersions(catalog: VersionCatalog): string[] {
  const all = new Set([...catalog.offered.map((e) => e.version), ...(catalog.bundled ? [catalog.bundled] : [])]);
  const published = new Set(catalog.offered.map((e) => e.version));
  return [...all].sort(
    (a, b) => comparePlainVersions(b, a) || Number(published.has(b)) - Number(published.has(a)),
  );
}
