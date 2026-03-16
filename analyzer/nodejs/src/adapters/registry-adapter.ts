import type { ManifestAdapter } from "../types.js";

const REGISTRY_BASE = "https://registry.telo.run";

export class RegistryAdapter implements ManifestAdapter {
  supports(url: string): boolean {
    return (
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("/") &&
      !url.startsWith(".") &&
      url.includes("@") &&
      url.includes("/")
    );
  }

  async read(moduleRef: string): Promise<{ text: string; source: string }> {
    const fetchUrl = this.toRegistryUrl(moduleRef);
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch manifest ${moduleRef}: ${response.status} ${response.statusText}`,
      );
    }
    return { text: await response.text(), source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseUrl = this.supports(base)
      ? this.toRegistryUrl(base).replace("/module.yaml", "")
      : base;
    const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(relative, baseWithSlash).href;
  }

  private toRegistryUrl(moduleRef: string): string {
    const atIdx = moduleRef.lastIndexOf("@");
    const modulePath = moduleRef.slice(0, atIdx);
    const version = moduleRef.slice(atIdx + 1);
    const versionSegment = version.startsWith("v") ? version.substring(1) : version;
    return `${REGISTRY_BASE}/${modulePath}/${versionSegment}/module.yaml`;
  }
}
