import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "../types.js";
import { splitIntegrity, verifiedFetch } from "./integrity.js";
import { isRegistryRef, parseModuleRef } from "./module-ref.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

export class RegistrySource implements ManifestSource {
  constructor(private registryUrl = DEFAULT_REGISTRY_URL) {}

  supports(url: string): boolean {
    return isRegistryRef(url);
  }

  async read(moduleRef: string): Promise<{ text: string; source: string }> {
    const { base, integrity } = splitIntegrity(moduleRef);
    const fetchUrl = this.toRegistryUrl(base);
    const { text } = await verifiedFetch(fetchUrl, integrity, base);
    // Some object-storage backends (e.g. Cloudflare R2 / S3) surface auth or
    // permission failures by returning a 200 status with an XML error body.
    // Catch this here so the loader produces a precise error rather than
    // silently parsing the XML as YAML and reporting a downstream UNDEFINED_KIND.
    if (text.trimStart().startsWith("<?xml") || text.trimStart().startsWith("<Error")) {
      const codeMatch = text.match(/<Code>([^<]+)<\/Code>/);
      const messageMatch = text.match(/<Message>([^<]+)<\/Message>/);
      const detail =
        codeMatch && messageMatch
          ? `${codeMatch[1]}: ${messageMatch[1]}`
          : text.slice(0, 200);
      throw new Error(
        `Registry returned a non-manifest response for ${base} ` +
          `(URL: ${fetchUrl}): ${detail}`,
      );
    }
    return { text, source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseUrl = this.supports(base) ? this.toRegistryModuleBase(base) : base;
    const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(relative, baseWithSlash).href;
  }

  private toRegistryModuleBase(moduleRef: string): string {
    const parsed = parseModuleRef(moduleRef);
    const normalizedBase = this.registryUrl.replace(/\/+$/, "");
    return `${normalizedBase}/${parsed.modulePath}/${parsed.version}`;
  }

  private toRegistryUrl(moduleRef: string): string {
    return `${this.toRegistryModuleBase(moduleRef)}/${DEFAULT_MANIFEST_FILENAME}`;
  }
}
