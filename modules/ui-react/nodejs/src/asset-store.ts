import type { AssetRef } from "@telorun/ui";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// How a built browser entry becomes addressed files is the vocabulary's rule.
export { entryAssets, type AssetRef } from "@telorun/ui";

/** One file to serve under `_telo/ui/assets/<digest>/<name>`, as it is handed
 *  over: its bytes, or the file on this host they are read from. */
export interface Asset {
  /** Hex SHA-256 the file is addressed by. */
  digest: string;
  name: string;
  mediaType: string;
  file?: string;
  body?: Buffer;
}

/** An asset whose bytes are held: what is served is what was read once. */
export interface HeldAsset extends Asset {
  body: Buffer;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Everything one application serves by content address. Every file is read
 *  when it is added, and never again. */
export class AssetStore {
  private readonly assets = new Map<string, HeldAsset>();
  private readonly read = new Map<string, Promise<Buffer>>();

  add(asset: HeldAsset): AssetRef {
    this.assets.set(`${asset.digest}/${asset.name}`, asset);
    return { digest: asset.digest, name: asset.name };
  }

  /** Add an asset, reading its file now when it carries no bytes. One file
   *  added under several addresses is read once. */
  async hold(asset: Asset): Promise<AssetRef> {
    if (asset.body !== undefined) return this.add(asset as HeldAsset);
    if (asset.file === undefined) {
      throw new Error(`The asset '${asset.name}' names neither bytes nor a file to read them from.`);
    }
    return this.add({ ...asset, body: await this.bytesOf(asset.file) });
  }

  /** The bytes of a file on this host, read once. */
  bytesOf(file: string): Promise<Buffer> {
    let bytes = this.read.get(file);
    if (!bytes) this.read.set(file, (bytes = readFile(file)));
    return bytes;
  }

  /** Bytes held in memory, addressed by their own digest. */
  addBytes(name: string, mediaType: string, body: Buffer): AssetRef {
    return this.add({ digest: sha256Hex(body), name, mediaType, body });
  }

  get(digest: string, name: string): HeldAsset | undefined {
    return this.assets.get(`${digest}/${name}`);
  }

  /**
   * One file reached under several digests — a chunk two entries of one build
   * share — must load once, or each entry would hold its own copy of what they
   * were built to share. Every address but the first maps onto that one.
   */
  sharedFileRemaps(urlOf: (ref: AssetRef) => string): Record<string, string> {
    const byFile = new Map<string, HeldAsset[]>();
    for (const asset of this.assets.values()) {
      if (asset.file === undefined) continue;
      byFile.set(asset.file, [...(byFile.get(asset.file) ?? []), asset]);
    }
    const remaps: Record<string, string> = {};
    for (const addresses of byFile.values()) {
      const urls = addresses.map(urlOf).sort();
      for (const url of urls.slice(1)) remaps[url] = urls[0];
    }
    return remaps;
  }
}
