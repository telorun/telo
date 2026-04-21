import type { ManifestAdapter } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { AppSettings, RegistryServer } from "../model";

export function isRegistryImportSource(source: string): boolean {
  return (
    !source.startsWith("http://") &&
    !source.startsWith("https://") &&
    !source.startsWith("/") &&
    !source.startsWith(".") &&
    source.includes("@") &&
    source.includes("/")
  );
}

export function parseRegistryRef(source: string): { moduleId: string; version: string } | null {
  if (!isRegistryImportSource(source)) return null;
  const atIdx = source.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === source.length - 1) return null;
  const moduleId = source.slice(0, atIdx);
  if (!moduleId.includes("/")) return null;
  const rawVersion = source.slice(atIdx + 1);
  const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
  return { moduleId, version };
}

export interface RegistryVersion {
  version: string;
  publishedAt: string;
}

export async function fetchAvailableVersions(
  moduleId: string,
  registryServers: RegistryServer[],
): Promise<RegistryVersion[]> {
  const enabled = registryServers.filter((s) => s.enabled);
  if (!enabled.length) return [];

  const results = await Promise.allSettled(
    enabled.map((server) =>
      fetch(`${server.url.replace(/\/$/, "")}/${moduleId}/versions`)
        .then((r) =>
          r.ok ? (r.json() as Promise<{ items: RegistryVersion[] }>) : { items: [] },
        )
        .then((data) => data.items ?? []),
    ),
  );

  const seen = new Set<string>();
  const merged: RegistryVersion[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        if (!seen.has(item.version)) {
          seen.add(item.version);
          merged.push(item);
        }
      }
    }
  }
  return merged;
}

// Creates ManifestAdapters for all enabled registry servers in settings.
export function createRegistryAdapters(settings: AppSettings): ManifestAdapter[] {
  function createSettingsRegistryAdapter(registryUrl: string): ManifestAdapter {
    const baseUrl = registryUrl.replace(/\/+$/, "");
    return {
      supports(url: string): boolean {
        return isRegistryImportSource(url);
      },
      async read(moduleRef: string): Promise<{ text: string; source: string }> {
        const atIdx = moduleRef.lastIndexOf("@");
        if (atIdx <= 0 || atIdx === moduleRef.length - 1) {
          throw new Error(
            `Invalid module reference '${moduleRef}', expected namespace/name@version`,
          );
        }

        const modulePath = moduleRef.slice(0, atIdx);
        const rawVersion = moduleRef.slice(atIdx + 1);
        const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
        const fetchUrl = `${baseUrl}/${modulePath}/${version}/${DEFAULT_MANIFEST_FILENAME}`;

        const response = await fetch(fetchUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch manifest ${moduleRef} from ${baseUrl}: ${response.status} ${response.statusText}`,
          );
        }

        return { text: await response.text(), source: fetchUrl };
      },
      resolveRelative(base: string, relative: string): string {
        const baseUrlForRelative = this.supports(base)
          ? (() => {
              const atIdx = base.lastIndexOf("@");
              const modulePath = base.slice(0, atIdx);
              const rawVersion = base.slice(atIdx + 1);
              const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
              return `${baseUrl}/${modulePath}/${version}`;
            })()
          : base;

        const baseWithSlash = baseUrlForRelative.endsWith("/")
          ? baseUrlForRelative
          : `${baseUrlForRelative}/`;
        return new URL(relative, baseWithSlash).href;
      },
    };
  }

  return settings.registryServers
    .filter((s) => s.enabled)
    .map((s) => createSettingsRegistryAdapter(s.url));
}
