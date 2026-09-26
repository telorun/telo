import { TeloMethod } from "@telorun/editor-protocol";
import type { HubRef, IdeEnvironmentAdapter, ModuleEntry } from "@telorun/ide-support";
import { dirnameOf, joinSource, uriOfSource } from "./document-uri.js";
import { errorText, type HostClient } from "./host-client.js";

/**
 * ide-support's environment over the `telo/*` requests, scoped to one document:
 * relative paths resolve against the document's directory, module-file paths
 * against its module's root. Hub lookups are best-effort by contract — a
 * completion popup must open whether or not the hub answers — so a failure is
 * logged to the host and answers empty.
 */
export class HostIdeAdapter implements IdeEnvironmentAdapter {
  constructor(
    private readonly host: HostClient,
    private readonly document: string,
    private readonly moduleRoot: string,
  ) {}

  async listDirectories(relPath: string): Promise<string[]> {
    const entries = await this.list(joinSource(dirnameOf(this.document), relPath));
    return entries.filter((entry) => entry.directory).map((entry) => entry.name);
  }

  hasManifest(relPath: string): Promise<boolean> {
    const dir = relPath.endsWith("/") ? relPath : `${relPath}/`;
    return this.host.request(TeloMethod.exists, {
      base: uriOfSource(this.document),
      relative: `${dir}telo.yaml`,
    });
  }

  async searchRefs(query: string): Promise<HubRef[]> {
    try {
      return await this.host.request(TeloMethod.hubSearchRefs, { query });
    } catch (error) {
      this.host.log(`telo: hub ref search failed for '${query}': ${errorText(error)}`);
      return [];
    }
  }

  async listVersionsForRef(ref: string): Promise<string[]> {
    try {
      const versions = await this.host.request(TeloMethod.hubListVersions, { ref });
      return versions.map((v) => v.version);
    } catch (error) {
      this.host.log(`telo: hub version lookup failed for ${ref}: ${errorText(error)}`);
      return [];
    }
  }

  listModuleEntries(relPath: string): Promise<ModuleEntry[]> {
    return this.list(joinSource(this.moduleRoot, relPath));
  }

  private async list(dir: string): Promise<ModuleEntry[]> {
    const entries = await this.host.request(TeloMethod.listDirectory, { uri: uriOfSource(dir) });
    return (entries ?? []).map((entry) => ({ name: entry.name, directory: entry.kind === "directory" }));
  }
}
