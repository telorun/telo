import type { CachedEngine, CatalogCache, EngineCache, StoredCatalog } from "@telorun/language-host";
import * as fs from "fs/promises";
import * as path from "path";

const ENGINE_FILE = "language-server.mjs";
const DIGEST_FILE = "language-server.mjs.sha512";

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Engines under `<root>/<version>/language-server.mjs`, each beside the digest
 *  recorded when it was stored; the catalog at `<root>/published.json`. */
export class FileEngineCache implements EngineCache, CatalogCache {
  constructor(private readonly root: string) {}

  async get(version: string): Promise<CachedEngine | undefined> {
    const dir = path.join(this.root, version);
    const [bytes, digest] = await Promise.all([
      readIfPresent(path.join(dir, ENGINE_FILE)),
      readIfPresent(path.join(dir, DIGEST_FILE)),
    ]);
    if (!bytes || !digest) return undefined;
    return { bytes: new Uint8Array(bytes), digest: digest.toString("utf8").trim() };
  }

  async put(version: string, engine: CachedEngine): Promise<void> {
    const dir = path.join(this.root, version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ENGINE_FILE), engine.bytes);
    await fs.writeFile(path.join(dir, DIGEST_FILE), `${engine.digest}\n`);
  }

  async has(version: string): Promise<boolean> {
    return (await this.get(version)) !== undefined;
  }

  async read(): Promise<StoredCatalog | undefined> {
    const text = await readIfPresent(path.join(this.root, "published.json"));
    return text ? (JSON.parse(text.toString("utf8")) as StoredCatalog) : undefined;
  }

  async write(catalog: StoredCatalog): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, "published.json"), JSON.stringify(catalog, null, 2));
  }
}
