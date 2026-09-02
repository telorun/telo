import { isOciRef, parseOciRef, type LoadedGraph, type ManifestSource } from "@telorun/analyzer";
import type { LocalManifestCacheSource } from "@telorun/kernel";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/** Sits beside `.validated.json` inside `<cacheRoot>/manifests/`. */
const ORIGINS_FILE = ".origins.json";
const ORIGINS_VERSION = 1;

interface OriginsRecord {
  version: number;
  /** `host/repo@tag` → the OCI manifest digest that produced the cached copy. */
  digests: Record<string, string>;
}

/**
 * True when `ref` names an OCI artifact by a **tag** rather than by content —
 * the only case a cached manifest can silently go stale.
 *
 * A `sha256:` *reference* addresses the OCI manifest directly and is immutable.
 * A tag the publisher can repoint is not, unless something else verifies the
 * bytes — which is what {@link isPinnedOciRef} covers separately, because the
 * pin does not survive into a resolved graph.
 */
export function isOciTagRef(ref: string): boolean {
  if (!isOciRef(ref)) return false;
  try {
    return !parseOciRef(ref).reference.includes(":");
  } catch {
    // An unparseable ref is not something this pass can revalidate; the loader
    // will report it as a resolution failure in its own right.
    return false;
  }
}

/** True when `ref` carries Telo's inline `#sha256-…` pin, which the cache source
 *  and the OCI transport both verify the manifest bytes against on every read.
 *  A moved tag therefore cannot be served undetected, so no `HEAD` is needed.
 *
 *  This must be asked of the ref **as authored**: `OciTransport` strips the
 *  fragment when it builds a module's canonical source, so a network-resolved
 *  graph no longer remembers that the import was pinned. */
export function isPinnedOciRef(ref: string): boolean {
  if (!isOciRef(ref)) return false;
  try {
    return Boolean(parseOciRef(ref).integrity);
  } catch {
    return false;
  }
}

/** Identity under which a mutable ref's origin digest is recorded:
 *  `host/repo@tag`, independent of scheme spelling. */
export function originKey(ref: string): string {
  const { host, repo, reference } = parseOciRef(ref);
  return `${host}/${repo}@${reference}`;
}

/**
 * Whether a cached manifest for `ref` may be served to `check` at all.
 *
 * The cache maps two key shapes, and only one of them addresses content that
 * cannot change under the key:
 *
 *  - `oci` — the reference is either a `sha256:` digest or a tag. A tag is
 *    mutable, which is what {@link revalidateMutableOciRefs} exists to catch,
 *    so both are cacheable and freshness is settled separately.
 *  - `url` — an arbitrary HTTP(S) import. Its key carries **no version
 *    segment**: one URL is one path forever, so a cached copy would be served
 *    for the lifetime of the directory no matter what the server now returns.
 *    `check` therefore never reads these from the cache and always re-fetches.
 *    That costs one request — exactly what revalidating would cost, since
 *    `HttpTransport.digest` is a full GET — so the honest option is also the
 *    cheap one. `telo run` keeps caching them; changing that is a separate
 *    decision about `run`'s freshness model, not a property of this pass.
 */
export function isCacheableForCheck(ref: string): boolean {
  return defaultTransportRegistry().cacheCoords(ref)?.transport !== "url";
}

/**
 * Wraps a manifest source and records which request URLs it actually served,
 * and from which file on disk.
 *
 * The freshness pass needs both halves, and neither survives into the loaded
 * graph: once the cache serves a manifest the graph's canonical source is a
 * `file://` URL, so the `oci://` ref that asked for it is gone. Recording at
 * the source is also what makes a *relative* import inside an OCI module work
 * here — the loader resolves it to an absolute `oci://` ref before `read()`,
 * so this map holds the absolute ref even though no manifest ever spelled it.
 */
export class RecordingCacheSource implements ManifestSource {
  /** Request URL → absolute path of the cache file that answered it. */
  readonly served = new Map<string, string>();

  constructor(private readonly inner: LocalManifestCacheSource) {}

  supports(url: string): boolean {
    return isCacheableForCheck(url) && this.inner.supports(url);
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const result = await this.inner.read(url);
    // The cache always answers with a `file://` URL; anything else means the
    // wrapped source is not disk-backed, and there is no cache file to record.
    if (result.source.startsWith("file://")) {
      this.served.set(url, fileURLToPath(result.source));
    }
    return result;
  }

  resolveRelative(base: string, relative: string): string {
    return this.inner.resolveRelative(base, relative);
  }
}

/**
 * Read the recorded origin digests for one cache root.
 *
 * A missing, unreadable, or version-mismatched record yields an empty map,
 * which makes every cached mutable ref count as *unverified* and therefore
 * stale. That is the conservative direction — the failure mode is one extra
 * fetch, never serving a manifest whose tag has moved. It is a cache miss in
 * the same sense `LocalManifestCacheSource` treats a failed `stat`, not a
 * suppressed error.
 */
export async function readOriginDigests(manifestsDir: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(manifestsDir, ORIGINS_FILE), "utf-8");
  } catch {
    return new Map();
  }
  let parsed: OriginsRecord;
  try {
    parsed = JSON.parse(raw) as OriginsRecord;
  } catch {
    return new Map();
  }
  if (parsed?.version !== ORIGINS_VERSION || typeof parsed.digests !== "object") {
    return new Map();
  }
  return new Map(Object.entries(parsed.digests));
}

/** Persist origin digests, merging over whatever the record already held so a
 *  check of one entry never drops another's. */
export async function writeOriginDigests(
  manifestsDir: string,
  digests: Map<string, string>,
): Promise<void> {
  if (digests.size === 0) return;
  const merged = new Map([...(await readOriginDigests(manifestsDir)), ...digests]);
  const record: OriginsRecord = {
    version: ORIGINS_VERSION,
    digests: Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, ORIGINS_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8",
  );
}

export interface FreshnessResult {
  /** Cache files whose tag has moved (or was never verified) since they were
   *  written. Deleting these and reloading is what makes the check honest. */
  staleFiles: string[];
  /** Current digest per origin key, to record once the load is trusted. */
  digests: Map<string, string>;
}

/**
 * Revalidate every **mutable** OCI ref this graph resolved, with one `HEAD` per
 * repository reference.
 *
 * `check` is the correctness command, so it must not report a clean bill of
 * health against a manifest whose tag has since moved. But re-pulling every
 * import to find that out is what made it slow, and a pinned ref — which is
 * what `telo install` writes and what every published manifest carries — needs
 * no network at all: its bytes are verified against the inline hash. So the
 * cost falls only on unpinned tags, and only one round trip each, against the
 * four a full re-pull would take.
 *
 * A ref fetched over the network during this load is fresh by construction and
 * is only recorded, never revalidated.
 */
export async function revalidateMutableOciRefs(
  graph: LoadedGraph,
  served: Map<string, string>,
  /** Recorded origin digests per cache root (keyed by its `manifests` dir). A
   *  cached manifest is judged against the record of the root it was served
   *  from, which is not necessarily the root this entry writes to: one loader
   *  serves every input path, so a hit may land in a sibling's cache. */
  originsByRoot: Map<string, Map<string, string>>,
  /** Digests already probed earlier in this invocation, keyed as {@link originKey}.
   *  A tag verified once in a process is verified for the whole run, so checking
   *  twenty manifests that share an import issues one `HEAD`, not twenty.
   *  Mutated in place so later paths see what earlier ones learned. */
  verified: Map<string, string> = new Map(),
): Promise<FreshnessResult> {
  const recordFor = (cacheFile: string): Map<string, string> => {
    let best: string | undefined;
    for (const root of originsByRoot.keys()) {
      if (!cacheFile.startsWith(root + path.sep)) continue;
      if (!best || root.length > best.length) best = root;
    }
    return (best && originsByRoot.get(best)) || new Map();
  };

  // A module's canonical source loses the `#sha256-` pin, so pinning has to be
  // read off the refs as authored. Collect every authored ref that reached each
  // canonical source; one pinned edge is enough, since edges sharing a canonical
  // source resolved the same tag and its bytes were verified against that pin.
  const pinnedSources = new Set<string>();
  for (const [, edges] of graph.importEdges) {
    for (const [, edge] of edges) {
      if (isPinnedOciRef(edge.targetRef)) pinnedSources.add(edge.targetSource);
    }
  }

  // Cache hits record the request URL, which keeps its pin — and is the only
  // place a relative import's absolute `oci://` ref survives.
  const cacheFileToRequest = new Map<string, string>();
  for (const [url, cacheFile] of served) {
    cacheFileToRequest.set(pathToFileURL(cacheFile).href, url);
  }

  const targets = new Map<string, { ref: string; cacheFile?: string }>();
  // Restricted to modules this graph actually reached — a shared loader carries
  // entries from previously-checked paths too.
  for (const source of graph.modules.keys()) {
    const request = cacheFileToRequest.get(source);
    const ref = request ?? source;
    if (!isOciTagRef(ref)) continue;
    if (isPinnedOciRef(ref) || pinnedSources.has(source)) continue;
    const key = originKey(ref);
    // The same tag reached twice can only differ in whether a copy sat on disk;
    // the cache-served one is what a staleness verdict has to act on.
    if (targets.get(key)?.cacheFile) continue;
    targets.set(key, {
      ref,
      ...(request ? { cacheFile: fileURLToPath(source) } : {}),
    });
  }

  if (targets.size === 0) return { staleFiles: [], digests: new Map() };

  const transports = defaultTransportRegistry();
  const resolved = await Promise.all(
    [...targets.entries()].map(async ([key, target]) => {
      const already = verified.get(key);
      if (already !== undefined) return [key, already] as const;
      const digest = await transports.digest(target.ref);
      if (digest) verified.set(key, digest);
      return [key, digest] as const;
    }),
  );

  const staleFiles: string[] = [];
  const digests = new Map<string, string>();
  for (const [key, digest] of resolved) {
    if (digest) digests.set(key, digest);
    const target = targets.get(key);
    if (!target?.cacheFile) continue;
    // A tag that no longer resolves (`null`) is stale too — dropping the cached
    // copy lets the reload surface the real resolution failure instead of
    // quietly analyzing a version the registry no longer publishes.
    if (digest && recordFor(target.cacheFile).get(key) === digest) continue;
    staleFiles.push(target.cacheFile);
  }

  return { staleFiles, digests };
}
