import { DEFAULT_MANIFEST_FILENAME, type ManifestAdapter } from "../types.js";

export class HttpAdapter implements ManifestAdapter {
  supports(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const fetchUrl = url.includes(".yaml") ? url : `${url}/${DEFAULT_MANIFEST_FILENAME}`;
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch manifest from ${fetchUrl}: ${response.status} ${response.statusText}`,
      );
    }
    return { text: await response.text(), source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseDir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, baseDir).href;
  }
}
