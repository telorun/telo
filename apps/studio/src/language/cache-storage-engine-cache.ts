import type { CachedEngine, EngineCache } from "@telorun/language-host";

/** The Cache Storage cache downloaded engines are kept in. */
export const ENGINE_CACHE_NAME = "telo-engines";
const DIGEST_HEADER = "x-telo-engine-digest";

/** Cache Storage keys by request URL; this origin-free one only names an entry. */
function entryUrl(version: string): string {
  return `https://telo-engines.invalid/${encodeURIComponent(version)}/language-server.mjs`;
}

/**
 * Downloaded engines in Cache Storage `telo-engines`, each stored with the
 * digest recorded when it was stored; the language host rechecks that digest
 * against the bytes on every load. A webview without Cache Storage keeps them
 * for the session only.
 */
export class CacheStorageEngineCache implements EngineCache {
  private readonly session = new Map<string, CachedEngine>();

  constructor(private readonly storage: CacheStorage | undefined = globalThis.caches) {}

  async get(version: string): Promise<CachedEngine | undefined> {
    if (!this.storage) return this.session.get(version);
    const cache = await this.storage.open(ENGINE_CACHE_NAME);
    const response = await cache.match(entryUrl(version));
    const digest = response?.headers.get(DIGEST_HEADER);
    if (!response || !digest) return undefined;
    return { bytes: new Uint8Array(await response.arrayBuffer()), digest };
  }

  async put(version: string, engine: CachedEngine): Promise<void> {
    if (!this.storage) {
      this.session.set(version, engine);
      return;
    }
    const cache = await this.storage.open(ENGINE_CACHE_NAME);
    await cache.put(
      entryUrl(version),
      new Response(engine.bytes as BodyInit, {
        headers: { "content-type": "text/javascript", [DIGEST_HEADER]: engine.digest },
      }),
    );
  }

  async has(version: string): Promise<boolean> {
    if (!this.storage) return this.session.has(version);
    const cache = await this.storage.open(ENGINE_CACHE_NAME);
    return (await cache.match(entryUrl(version))) !== undefined;
  }
}
