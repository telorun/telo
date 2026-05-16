import type { IdeEnvironmentAdapter, RegistryModule } from "@telorun/ide-support";
import * as vscode from "vscode";

interface SearchResponse {
  results?: Array<{
    namespace?: string;
    name?: string;
    version?: string;
    description?: string;
  }>;
}

interface VersionsResponse {
  items?: Array<{ version?: string }>;
}

/** Reads `telo.registryUrl` once per call so config changes apply without
 *  restarting the language host. Trailing slashes are normalized off. */
function getRegistryUrl(): string {
  const cfg = vscode.workspace.getConfiguration("telo");
  const raw = cfg.get<string>("registryUrl") ?? "https://registry.telo.run";
  return raw.replace(/\/+$/, "");
}

/** Bridge between ide-support's host-agnostic completion code and the VSCode
 *  workspace API. Scoped to a single document — the manifest's directory is
 *  the base for all relative-path resolution. */
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

  async searchRegistry(query: string): Promise<RegistryModule[]> {
    // limit=100 (vs the server default of 20) gives client-side namespace
    // filtering enough headroom to still produce a useful popover after
    // narrowing by the typed `<namespace>/` prefix.
    const url = `${getRegistryUrl()}/search?q=${encodeURIComponent(query)}&limit=100`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as SearchResponse;
      return (data.results ?? [])
        .filter((r) => r.namespace && r.name && r.version)
        .map((r) => ({
          namespace: r.namespace as string,
          name: r.name as string,
          version: r.version as string,
          description: r.description,
        }));
    } catch {
      return [];
    }
  }

  async listRegistryVersions(namespace: string, name: string): Promise<string[]> {
    const url = `${getRegistryUrl()}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/versions`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as VersionsResponse;
      return (data.items ?? []).map((i) => i.version).filter((v): v is string => !!v);
    } catch {
      return [];
    }
  }

  private resolveRel(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.manifestDirUri, relPath);
  }
}
