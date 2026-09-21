import type { ManifestSource } from "@telorun/analyzer";
import type { AppSettings } from "../model";
import { applyEdit, parseModuleDocument, serializeModuleDocument } from "../yaml-document";
import { pathDirname } from "./paths";
import { buildRemoteImportPlan, createVirtualWorkspaceAdapter } from "./remote";

// ---------------------------------------------------------------------------
// Starters — a curated set of working manifests the editor offers on first run
// and when creating a new module, copied once into the user's workspace. The
// manifests are NOT bundled: they are fetched over http(s) from
// `startersBaseUrl`, which serves a `starters.json` catalog plus the referenced
// manifests (and any `files:` assets). The fetch reuses the remote-open
// machinery (`buildRemoteImportPlan`) so multi-file starters — relative
// imports, include partials, listed assets — work exactly as `?open` does, only
// mapped to paths relative to the starter's own folder so a caller can place it
// anywhere.
// ---------------------------------------------------------------------------

/** Base URL the gallery loads from when `settings.startersBaseUrl` is unset. */
export const DEFAULT_STARTERS_BASE_URL =
  "https://raw.githubusercontent.com/telorun/telo/refs/heads/main/starters";

export type StarterCategory = "app" | "library";

/** One catalog entry from `starters.json`. `path` is relative to the base URL
 *  and points at the starter's root `telo.yaml`. */
export interface StarterDescriptor {
  id: string;
  title: string;
  description: string;
  category: StarterCategory;
  path: string;
}

export interface StarterCatalog {
  starters: StarterDescriptor[];
}

/** A materialized starter file, its path relative to the destination module
 *  directory (`telo.yaml`, `public/index.html`, …). */
export interface StarterFile {
  relPath: string;
  text: string;
  isRoot: boolean;
}

/** Resolves the effective base URL (trimmed of trailing slashes), falling back
 *  to the public default when the setting is empty. */
export function resolveStartersBaseUrl(settings: AppSettings): string {
  const raw = settings.startersBaseUrl?.trim();
  return (raw || DEFAULT_STARTERS_BASE_URL).replace(/\/+$/, "");
}

/** Full URL of a starter's root manifest. */
export function starterManifestUrl(baseUrl: string, starter: StarterDescriptor): string {
  return `${baseUrl.replace(/\/+$/, "")}/${starter.path.replace(/^\/+/, "")}`;
}

/** Fetches and validates the starter catalog. Throws an actionable error on
 *  network failure, non-OK status, or a malformed body. */
export async function fetchStarterCatalog(baseUrl: string): Promise<StarterCatalog> {
  const url = `${baseUrl.replace(/\/+$/, "")}/starters.json`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch starter catalog from ${url}: ${reason}. The host must allow cross-origin requests (CORS).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not fetch starter catalog from ${url}: HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const data: unknown = await response.json();
  const starters = (data as { starters?: unknown } | null)?.starters;
  if (!Array.isArray(starters)) {
    throw new Error(`Starter catalog at ${url} is malformed: expected { "starters": [ … ] }.`);
  }
  return { starters: starters as StarterDescriptor[] };
}

/** Fetches a starter's full file set and maps every file to a path relative to
 *  the starter's own folder, with the root manifest's `metadata.name` rewritten
 *  to `name`. Reuses `buildRemoteImportPlan` (same-origin relative cascade +
 *  listed `files:` assets); a file resolving outside the starter folder is an
 *  unsupported layout and throws. */
export async function fetchStarterFiles(
  manifestUrl: string,
  name: string,
  registryAdapters: ManifestSource[],
): Promise<StarterFile[]> {
  const scratch = createVirtualWorkspaceAdapter();
  const plan = await buildRemoteImportPlan(manifestUrl, scratch, registryAdapters);
  const moduleDir = pathDirname(plan.rootDestPath);
  const prefix = `${moduleDir}/`;

  const files: StarterFile[] = [];
  for (const file of plan.files) {
    if (!file.destPath.startsWith(prefix)) {
      throw new Error(
        `Starter file ${file.url} resolves outside its folder — a starter must be self-contained.`,
      );
    }
    const relPath = file.destPath.slice(prefix.length);
    const text = file.isRoot ? rewriteMetadataName(plan.rootDestPath, file.text, name) : file.text;
    files.push({ relPath, text, isRoot: file.isRoot });
  }
  return files;
}

/** Rewrites the root Application/Library document's `metadata.name` in place,
 *  preserving formatting and `!cel`/`!ref` tags via the AST edit path. Returns
 *  the text unchanged when no Application/Library doc is present. */
export function rewriteMetadataName(filePath: string, text: string, name: string): string {
  const modDoc = parseModuleDocument(filePath, text);
  const docs = modDoc.loaded.documents;
  const index = docs.findIndex((doc) => {
    const json = doc.toJSON() as { kind?: unknown } | null;
    return json?.kind === "Telo.Application" || json?.kind === "Telo.Library";
  });
  if (index < 0) return text;
  const updated = applyEdit(docs, index, { op: "set", pointer: "/metadata/name", value: name });
  return serializeModuleDocument(updated);
}
