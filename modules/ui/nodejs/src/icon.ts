import type { ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AssetRef } from "./browser-entry-assets.js";
import type { AssetFile } from "./composite.js";
import { servedIconFormat } from "./icon-format.js";

/** What every `Ui.Icon` provides: the image file its glyph is drawn from. */
export interface IconFile {
  /** An absolute path on this host. */
  file: string;
}

export interface IconInstance {
  provide(): Promise<IconFile>;
}

export const isIcon = (candidate: unknown): candidate is IconInstance =>
  typeof (candidate as IconInstance | null)?.provide === "function";

export const FileIconController = {
  async create(resource: RuntimeResource & { file: string }): Promise<ResourceInstance> {
    return { provide: async (): Promise<IconFile> => ({ file: resource.file }) };
  },
};

/**
 * An icon's file as a renderer reaches it: the address a node carries, and the
 * file to serve under it — addressed by the digest of its bytes, named by its
 * own name and the format read from those bytes, refused when a browser could
 * not draw it as a glyph.
 */
export async function iconAsset({ file }: IconFile, owner: string, where: string): Promise<{ ref: AssetRef; asset: AssetFile }> {
  const bytes = await readFile(file);
  const format = servedIconFormat(bytes, file, owner, where);
  const slug = basename(file).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const asset: AssetFile = {
    digest: createHash("sha256").update(bytes).digest("hex"),
    name: `${slug || "icon"}.${format.extension}`,
    file,
    mediaType: format.mediaType,
  };
  return { ref: { digest: asset.digest, name: asset.name }, asset };
}
