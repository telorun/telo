/**
 * The layer store (`kernel/specs/module-artifact.md` §5.2): where a layer that
 * describes an artifact and holds no module file — the `sbom` role — is kept,
 * once fetched and verified. Never a module directory: two modules sharing one
 * directory (a nested file manifest beside its owner) each have such a layer,
 * at the same in-layer path.
 *
 * `<cache root>/layers/sha256-<blob hex>/`, keyed by the layer's `blob`, written
 * to a private temporary directory and renamed into place, so a directory that
 * exists is complete; its integrity is re-derived from it on every read.
 */

import { RuntimeError } from "@telorun/sdk";
import type { ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { computeFilesIntegrity, isPayloadLink, readPayloadFile, type PayloadFile } from "./files-integrity.js";
import { describeLayerViolations, findLayerViolations } from "./layer-entry-rules.js";

/** The store's directory under a cache root. */
export const LAYER_STORE_DIRECTORY = "layers";

/** Where the layer with `blob` is stored under `cacheRoot`. */
export function storedLayerDirectory(cacheRoot: string, blob: string): string {
  return path.join(cacheRoot, LAYER_STORE_DIRECTORY, blob.replace(/^sha256:/, "sha256-"));
}

/** What fetches a layer by its blob digest — the transport registry. */
export interface LayerFetcher {
  fetchLayer(ref: string, blobDigest: string): Promise<PayloadFile[]>;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, name)));
    else out.push(name);
  }
  return out.sort();
}

/**
 * The stored layer's files, or `undefined` when the store does not hold it — or
 * holds a copy whose integrity no longer matches, which is removed so the next
 * fetch replaces it. `removeStale: false` leaves such a copy in place, for a root
 * that is read and never written (a packaged payload's sealed store).
 */
export async function readStoredLayer(
  cacheRoot: string,
  layer: ArtifactLayer,
  options: { readonly removeStale?: boolean } = {},
): Promise<{ dir: string; files: PayloadFile[] } | undefined> {
  const dir = storedLayerDirectory(cacheRoot, layer.blob);
  let names: string[];
  try {
    names = await listFiles(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const files = await Promise.all(names.map((name) => readPayloadFile(dir, name)));
  if ((await computeFilesIntegrity(files)) === layer.integrity) return { dir, files };
  if (options.removeStale !== false) await fs.rm(dir, { recursive: true, force: true });
  return undefined;
}

let tmpCounter = 0;

/**
 * The layer's files from the store, fetched by `blob` from the artifact
 * `pinnedRef` names and stored first when the store does not hold them. The
 * fetched files are held to `integrity` before anything is written.
 *
 * `sealedRoot` is a store that is read and never written: a copy there that
 * verifies is used; a missing or mismatching one is left as it is and the layer
 * is fetched into `cacheRoot` instead.
 */
export async function materializeStoredLayer(options: {
  readonly cacheRoot: string;
  readonly pinnedRef: string;
  readonly layer: ArtifactLayer;
  readonly transports: LayerFetcher;
  readonly sealedRoot?: string;
}): Promise<{ dir: string; files: PayloadFile[] }> {
  const { cacheRoot, pinnedRef, layer, transports, sealedRoot } = options;
  if (sealedRoot !== undefined) {
    const sealed = await readStoredLayer(sealedRoot, layer, { removeStale: false });
    if (sealed) return sealed;
  }
  const stored = await readStoredLayer(cacheRoot, layer);
  if (stored) return stored;

  const files = await transports.fetchLayer(pinnedRef, layer.blob);
  const actual = await computeFilesIntegrity(files);
  if (actual !== layer.integrity) {
    throw new RuntimeError(
      "ERR_MODULE_LAYER_INTEGRITY",
      `Integrity check failed for the ${layer.role} layer of ${pinnedRef}: expected ` +
        `${layer.integrity}, got ${actual}. The layer's contents do not match the digest recorded ` +
        `in the module's pinned telo.yaml — it may have been tampered with or republished.`,
    );
  }
  const dir = storedLayerDirectory(cacheRoot, layer.blob);
  const tmp = `${dir}.${process.pid}.${tmpCounter++}.tmp`;
  const escaping = files.find((file) => {
    const relative = path.relative(tmp, path.resolve(tmp, file.name));
    return relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
  });
  const violations = findLayerViolations(files);
  if (escaping || violations.length > 0) {
    throw new RuntimeError(
      "ERR_MODULE_LAYER_INVALID",
      `The ${layer.role} layer of ${pinnedRef} has entries that cannot be stored` +
        (escaping ? `: '${escaping.name}' resolves outside the layer.` : `:\n${describeLayerViolations(violations)}`),
    );
  }
  try {
    for (const file of files) {
      const target = path.join(tmp, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (isPayloadLink(file)) {
        await fs.symlink(file.link, target, "file");
      } else {
        await fs.writeFile(target, file.content);
        if (file.executable) await fs.chmod(target, 0o755);
      }
    }
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    // A peer storing the same blob renamed first; its copy is read and verified.
    const peer = await readStoredLayer(cacheRoot, layer);
    if (peer) return peer;
    throw err;
  }
  return { dir, files };
}
