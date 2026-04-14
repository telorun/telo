import { DEFAULT_MANIFEST_FILENAME, type ManifestAdapter } from "../types.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

export class RegistryAdapter implements ManifestAdapter {
  constructor(private registryUrl = DEFAULT_REGISTRY_URL) {}

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
    const baseUrl = this.supports(base) ? this.toRegistryModuleBase(base) : base;
    const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(relative, baseWithSlash).href;
  }

  private toRegistryModuleBase(moduleRef: string): string {
    const parsed = this.parseModuleRef(moduleRef);
    const normalizedBase = this.registryUrl.replace(/\/+$/, "");
    return `${normalizedBase}/${parsed.modulePath}/${parsed.version}`;
  }

  private toRegistryUrl(moduleRef: string): string {
    return `${this.toRegistryModuleBase(moduleRef)}/${DEFAULT_MANIFEST_FILENAME}`;
  }

  private parseModuleRef(moduleRef: string): { modulePath: string; version: string } {
    const atIdx = moduleRef.lastIndexOf("@");
    if (atIdx <= 0 || atIdx === moduleRef.length - 1) {
      throw new Error(`Invalid module reference '${moduleRef}', expected namespace/name@version`);
    }

    const modulePath = moduleRef.slice(0, atIdx);
    if (!modulePath.includes("/")) {
      throw new Error(`Invalid module reference '${moduleRef}', expected namespace/name@version`);
    }

    const rawVersion = moduleRef.slice(atIdx + 1);
    const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
    if (!version) {
      throw new Error(`Invalid module reference '${moduleRef}', expected namespace/name@version`);
    }

    return { modulePath, version };
  }
}
