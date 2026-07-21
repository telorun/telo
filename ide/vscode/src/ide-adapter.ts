import type { HubRef, IdeEnvironmentAdapter } from "@telorun/ide-support";
import * as vscode from "vscode";

interface RefsResponse {
  refs?: Array<{ ref?: string; latestVersion?: string; description?: string }>;
}

interface VersionsResponse {
  versions?: string[];
}

/** Reads `telo.registryUrl` once per call so config changes apply without
 *  restarting the language host. Trailing slashes are normalized off. Drives
 *  the kernel transport registry that resolves imports during analysis — a
 *  separate concern from federated import autocomplete (`getHubUrl`). */
export function getRegistryUrl(): string {
  const cfg = vscode.workspace.getConfiguration("telo");
  const raw = cfg.get<string>("registryUrl") ?? "https://registry.telo.run";
  return raw.replace(/\/+$/, "");
}

/** Reads `telo.hubUrl` once per call. Mirrors the CLI's `TELO_HUB_URL`
 *  default (`https://telo.sh`); a self-hosted setup overrides it. */
export function getHubUrl(): string {
  const cfg = vscode.workspace.getConfiguration("telo");
  const raw = cfg.get<string>("hubUrl") ?? "https://telo.sh";
  return raw.replace(/\/+$/, "");
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

  async listVersionsForRef(ref: string): Promise<string[]> {
    const url = `${getHubUrl()}/module/versions?ref=${encodeURIComponent(ref)}`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return [];
      const data = (await res.json()) as VersionsResponse;
      return (data.versions ?? []).filter((v): v is string => typeof v === "string");
    } catch (err) {
      console.warn(`telo: hub version lookup failed (${url}): ${errText(err)}`);
      return [];
    }
  }

  private resolveRel(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.manifestDirUri, relPath);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
