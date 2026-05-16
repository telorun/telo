import type { IdeEnvironmentAdapter, RegistryModule } from "@telorun/ide-support";
import type { RegistryServer, WorkspaceAdapter } from "../../../model";
import { pathJoin } from "../../../loader/paths";

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

/** Reuses the editor's existing TauriFsAdapter for filesystem reads and the
 *  user-configured registry servers (from settings) for HTTP lookups. One
 *  instance per completion call — scoped to the directory of the manifest
 *  the user is editing. */
export class EditorIdeAdapter implements IdeEnvironmentAdapter {
  constructor(
    private readonly manifestDir: string,
    private readonly workspace: WorkspaceAdapter,
    private readonly registryServers: readonly RegistryServer[],
  ) {}

  async listDirectories(relPath: string): Promise<string[]> {
    const target = pathJoin(this.manifestDir, relPath);
    try {
      const entries = await this.workspace.listDir(target);
      return entries.filter((e) => e.isDirectory).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async hasManifest(relPath: string): Promise<boolean> {
    const target = pathJoin(this.manifestDir, relPath, "telo.yaml");
    try {
      await this.workspace.readFile(target);
      return true;
    } catch {
      return false;
    }
  }

  async searchRegistry(query: string): Promise<RegistryModule[]> {
    return this.queryEnabledServers(async (baseUrl) => {
      // limit=100 (vs the server default of 20) gives client-side namespace
      // filtering enough headroom to still produce a useful popover after
      // narrowing by the typed `<namespace>/` prefix.
      const res = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}&limit=100`);
      if (!res.ok) return [];
      const data = (await res.json()) as SearchResponse;
      return (data.results ?? [])
        .filter((r) => r.namespace && r.name && r.version)
        .map<RegistryModule>((r) => ({
          namespace: r.namespace as string,
          name: r.name as string,
          version: r.version as string,
          description: r.description,
        }));
    }, dedupeById);
  }

  async listRegistryVersions(namespace: string, name: string): Promise<string[]> {
    return this.queryEnabledServers(
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/versions`,
        );
        if (!res.ok) return [];
        const data = (await res.json()) as VersionsResponse;
        return (data.items ?? []).map((i) => i.version).filter((v): v is string => !!v);
      },
      dedupeStrings,
    );
  }

  /** Fan-out to every enabled registry, merge with a caller-supplied deduper.
   *  Failures on individual servers are dropped silently — completion is
   *  best-effort and a single unreachable server shouldn't blank the popover
   *  when others responded. */
  private async queryEnabledServers<T>(
    fn: (baseUrl: string) => Promise<T[]>,
    merge: (lists: T[][]) => T[],
  ): Promise<T[]> {
    const enabled = this.registryServers.filter((s) => s.enabled);
    if (enabled.length === 0) return [];
    const settled = await Promise.allSettled(
      enabled.map((s) => fn(s.url.replace(/\/+$/, ""))),
    );
    const lists = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    return merge(lists);
  }
}

function dedupeById(lists: RegistryModule[][]): RegistryModule[] {
  const seen = new Set<string>();
  const out: RegistryModule[] = [];
  for (const list of lists) {
    for (const m of list) {
      const id = `${m.namespace}/${m.name}@${m.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(m);
    }
  }
  return out;
}

function dedupeStrings(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const v of list) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
