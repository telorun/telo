import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "../types.js";
import { splitIntegrity, verifiedFetch } from "./integrity.js";

export class HttpSource implements ManifestSource {
  supports(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const { base, integrity } = splitIntegrity(url);
    const fetchUrl = base.includes(".yaml") ? base : `${base}/${DEFAULT_MANIFEST_FILENAME}`;
    const { text } = await verifiedFetch(fetchUrl, integrity, fetchUrl);
    return { text, source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseDir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, baseDir).href;
  }
}
