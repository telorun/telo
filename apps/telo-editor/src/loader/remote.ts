import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { WorkspaceAdapter } from "../model";
import { moduleParseError, parseModuleDocument } from "../yaml-document";
import { LocalStorageAdapter } from "./adapters/local-storage";

// ---------------------------------------------------------------------------
// Remote manifest open — the "Open in Telo Editor" entry point.
//
// A link of the form `<editor>/?open=<url>` fetches a single manifest over
// HTTP and copies it into an in-browser virtual workspace under
// `/workspace/apps/<slug>/telo.yaml`, where it is edited purely locally. The
// manifest's imports resolve from that local copy (registry refs via the
// registry adapters); we deliberately copy only the one file, so relative
// imports surface as honest unresolved-import diagnostics.
// ---------------------------------------------------------------------------

/** Query-string key carrying the URL of the manifest to open. */
export const OPEN_PARAM = "open";

/** Root of the in-browser virtual workspace remote manifests are copied into. */
export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

export interface RemoteManifest {
  /** The URL the manifest was fetched from. */
  url: string;
  /** Raw YAML text, written verbatim into the workspace. */
  text: string;
  /** `metadata.name` of the root Application/Library doc. */
  metadataName: string;
  /** Folder slug derived from `metadataName`. */
  slug: string;
  /** Destination path inside the virtual workspace. */
  destPath: string;
}

/** Reads the manifest URL from a `location.search` string, or null when absent. */
export function readManifestUrlParam(search: string): string | null {
  const trimmed = new URLSearchParams(search).get(OPEN_PARAM)?.trim();
  return trimmed ? trimmed : null;
}

/** Strips the manifest param from the address bar so a reload doesn't re-import. */
export function clearManifestUrlParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(OPEN_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
}

/** Derives a kebab-case folder name from a module's `metadata.name`
 *  (`HelloApiExample` → `hello-api-example`, `HTTPServer` → `http-server`). */
export function slugifyModuleName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Constructs the localStorage-backed virtual workspace adapter. */
export function createVirtualWorkspaceAdapter(): LocalStorageAdapter {
  return new LocalStorageAdapter(VIRTUAL_WORKSPACE_ROOT);
}

/** True when a file already exists at `destPath` in the workspace. */
export async function manifestExists(
  adapter: WorkspaceAdapter,
  destPath: string,
): Promise<boolean> {
  const slash = destPath.lastIndexOf("/");
  const dir = destPath.slice(0, slash);
  const filename = destPath.slice(slash + 1);
  const entries = await adapter.listDir(dir);
  return entries.some((e) => !e.isDirectory && e.name === filename);
}

/** Fetches a manifest over HTTP and resolves its destination in the virtual
 *  workspace. Throws with an actionable message on network failure, non-OK
 *  status, parse errors, or a missing Application/Library doc. */
export async function fetchRemoteManifest(url: string): Promise<RemoteManifest> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid manifest URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported manifest URL scheme "${parsed.protocol}" — only http and https links can be opened.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch manifest from ${url}: ${reason}. The host must allow cross-origin requests (CORS).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not fetch manifest from ${url}: HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const text = await response.text();
  const doc = parseModuleDocument(url, text);
  const parseError = moduleParseError(doc);
  if (parseError) {
    throw new Error(`Manifest at ${url} is not valid YAML: ${parseError}`);
  }

  const moduleDoc = doc.loaded.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  );
  if (!moduleDoc) {
    throw new Error(
      `Manifest at ${url} has no Telo.Application or Telo.Library document — it cannot be opened in the editor.`,
    );
  }

  const name = moduleDoc.metadata?.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Manifest at ${url} is missing metadata.name.`);
  }

  const slug = slugifyModuleName(name);
  if (!slug) {
    throw new Error(
      `Could not derive a workspace folder from metadata.name "${name}" — it has no alphanumeric characters.`,
    );
  }

  const destPath = `${VIRTUAL_WORKSPACE_ROOT}/apps/${slug}/${DEFAULT_MANIFEST_FILENAME}`;
  return { url, text, metadataName: name, slug, destPath };
}

/** Writes the fetched manifest into the virtual workspace, creating its
 *  containing directory. Overwrites any existing file at the destination. */
export async function writeRemoteManifest(
  adapter: WorkspaceAdapter,
  remote: RemoteManifest,
): Promise<void> {
  const dir = remote.destPath.slice(0, remote.destPath.lastIndexOf("/"));
  await adapter.createDir(dir);
  await adapter.writeFile(remote.destPath, remote.text);
}
