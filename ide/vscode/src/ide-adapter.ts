import {
  parseModuleVersions,
  type HubRef,
  type IdeEnvironmentAdapter,
  type ModuleVersion,
} from "@telorun/ide-support";
import * as vscode from "vscode";

interface RefsResponse {
  refs?: Array<{ ref?: string; latestVersion?: string; description?: string }>;
}

/** Reads `telo.hubUrl` once per call. Mirrors the CLI's `TELO_HUB_URL`
 *  default (`https://telo.sh`); a self-hosted setup overrides it. */
export function getHubUrl(): string {
  const cfg = vscode.workspace.getConfiguration("telo");
  const raw = cfg.get<string>("hubUrl") ?? "https://telo.sh";
  return raw.replace(/\/+$/, "");
}

/** Every version the hub tracks for a location ref, newest first
 *  (`GET /module/versions?ref=`), each with the import pin for that version
 *  when the hub has one. Standalone rather than a method so a caller needing
 *  only versions doesn't have to build a directory-scoped adapter, and so
 *  failures stay visible: this rejects, and each caller picks its own policy.
 *  Returns `[]` for a module the hub does not track (404). */
export async function fetchHubVersions(ref: string): Promise<ModuleVersion[]> {
  const base = getHubUrl();
  const url = `${base}/module/versions?ref=${encodeURIComponent(ref)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new Error(`could not reach the telo hub at ${base}: ${errText(err)}`);
  }
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`hub returned HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return parseModuleVersions(await res.json());
}

/** Bridge between ide-support's host-agnostic completion code and the VSCode
 *  workspace API. Scoped to a single document — the manifest's directory is
 *  the base for all relative-path resolution. Federated ref / version lookups
 *  go to the configured telo hub. */
export class VsCodeIdeAdapter implements IdeEnvironmentAdapter {
  constructor(private readonly manifestDirUri: vscode.Uri) {}

  async listDirectories(relPath: string): Promise<string[]> {
    const targetUri = this.resolveRel(relPath);
    try {
      const entries = await vscode.workspace.fs.readDirectory(targetUri);
      return entries
        .filter(([, type]) => (type & vscode.FileType.Directory) !== 0)
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  async hasManifest(relPath: string): Promise<boolean> {
    const manifestUri = this.resolveRel(`${relPath}${relPath.endsWith("/") ? "" : "/"}telo.yaml`);
    try {
      const stat = await vscode.workspace.fs.stat(manifestUri);
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }

  async searchRefs(query: string): Promise<HubRef[]> {
    const url = `${getHubUrl()}/refs?q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return [];
      const data = (await res.json()) as RefsResponse;
      return (data.refs ?? [])
        .filter((r) => r.ref)
        .map((r) => ({
          ref: r.ref as string,
          latestVersion: r.latestVersion ?? "",
          description: r.description,
        }));
    } catch (err) {
      // Best-effort: an unreachable/misconfigured hub must not throw into the
      // completion provider. Leave a breadcrumb so a wrong `telo.hubUrl` is
      // diagnosable rather than a silently empty popover.
      console.warn(`telo: hub ref search failed (${url}): ${errText(err)}`);
      return [];
    }
  }

  listVersionsForRef(ref: string): Promise<string[]> {
    // Completion offers version names; the pin each entry carries is for the
    // upgrade path, which calls `fetchHubVersions` directly.
    return fetchHubVersions(ref)
      .then((versions) => versions.map((v) => v.version))
      .catch((err) => {
        // Best-effort: an unreachable hub must not throw into the popover.
        console.warn(`telo: hub version lookup failed for ${ref}: ${errText(err)}`);
        return [];
      });
  }

  private resolveRel(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.manifestDirUri, relPath);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
