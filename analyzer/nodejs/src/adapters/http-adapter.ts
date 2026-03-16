import type { ManifestAdapter } from "../types.js";

export class HttpAdapter implements ManifestAdapter {
  supports(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const fetchUrl = url.includes(".yaml") ? url : `${url}/module.yaml`;
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch manifest from ${fetchUrl}: ${response.status} ${response.statusText}`,
      );
    }
    return { text: await response.text(), source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
    return new URL(relative, baseWithSlash).href;
  }
}
