import type { BrowserEntryFiles } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { dirname, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetFile } from "./composite.js";

/** The address of one served file: the digest it sits under, and its path below it. */
export interface AssetRef {
  digest: string;
  name: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

/** The deepest directory holding every file, so each keeps its place relative
 *  to the others — an entry imports its chunks by relative path. */
function commonDirectory(files: string[]): string {
  let common = dirname(files[0]);
  for (const file of files) {
    while (relative(common, file).startsWith("..")) common = dirname(common);
  }
  return common;
}

/** A built browser entry as the files a browser loads for it: the entry and
 *  everything beside it, under one digest derived from the entry's own. */
export function entryAssets(entry: BrowserEntryFiles): { module: AssetRef; assets: AssetFile[] } {
  const digest = createHash("sha256").update(entry.digest).digest("hex");
  const entryFile = fileURLToPath(entry.file);
  const files = [entryFile, ...entry.siblings.map((uri) => fileURLToPath(uri))];
  const base = commonDirectory(files);
  const nameOf = (file: string) => relative(base, file).split(sep).join("/");
  return {
    module: { digest, name: nameOf(entryFile) },
    assets: files.map((file) => ({
      digest,
      name: nameOf(file),
      file,
      mediaType: MEDIA_TYPES[extname(file)] ?? "application/octet-stream",
    })),
  };
}
