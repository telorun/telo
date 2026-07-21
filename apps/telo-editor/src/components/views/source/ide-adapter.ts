import type { HubRef, IdeEnvironmentAdapter } from "@telorun/ide-support";
import type { WorkspaceAdapter } from "../../../model";
import { pathJoin } from "../../../loader/paths";

/** Public hub, mirroring the CLI's `TELO_HUB_URL` default. A self-hosted setup
 *  overrides it via the `hubUrl` setting. */
const DEFAULT_HUB_URL = "https://telo.sh";

interface RefsResponse {
  refs?: Array<{ ref?: string; latestVersion?: string; description?: string }>;
}

interface VersionsResponse {
  versions?: string[];
}

/** Reuses the editor's existing TauriFsAdapter for filesystem reads and the
 *  configured telo hub (from settings) for federated ref / version lookups.
 *  One instance per completion call — scoped to the directory of the manifest
 *  the user is editing. */
export class EditorIdeAdapter implements IdeEnvironmentAdapter {
  private readonly hubUrl: string;

  constructor(
    private readonly manifestDir: string,
    private readonly workspace: WorkspaceAdapter,
    hubUrl: string | undefined,
  ) {
    this.hubUrl = (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, "");
  }

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

  async searchRefs(query: string): Promise<HubRef[]> {
    try {
      const res = await fetch(`${this.hubUrl}/refs?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as RefsResponse;
      return (data.refs ?? [])
        .filter((r) => r.ref)
        .map<HubRef>((r) => ({
          ref: r.ref as string,
          latestVersion: r.latestVersion ?? "",
          description: r.description,
        }));
    } catch (err) {
      // Best-effort: an unreachable/misconfigured hub must not throw into the
      // completion provider. Leave a breadcrumb so a wrong `hubUrl` is
      // diagnosable rather than a silently empty popover.
      console.warn(`telo: hub ref search failed (${this.hubUrl}): ${errText(err)}`);
      return [];
    }
  }

  async listVersionsForRef(ref: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.hubUrl}/module/versions?ref=${encodeURIComponent(ref)}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as VersionsResponse;
      return (data.versions ?? []).filter((v): v is string => typeof v === "string");
    } catch (err) {
      console.warn(`telo: hub version lookup failed (${this.hubUrl}): ${errText(err)}`);
      return [];
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
