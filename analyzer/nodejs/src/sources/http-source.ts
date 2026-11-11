import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "../types.js";
import { splitIntegrity, verifiedFetch } from "./integrity.js";

/** The URL a module requested as `ref` is read from, or `undefined` when `ref`
 *  is not an http(s) URL: the URL itself when it names a YAML file, else the
 *  `telo.yaml` beneath it. */
export function httpManifestUrl(ref: string): string | undefined {
  const { base } = splitIntegrity(ref);
  if (!base.startsWith("http://") && !base.startsWith("https://")) return undefined;
  return base.includes(".yaml") ? base : `${base}/${DEFAULT_MANIFEST_FILENAME}`;
}

export class HttpSource implements ManifestSource {
  supports(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const { integrity } = splitIntegrity(url);
    const fetchUrl = httpManifestUrl(url) ?? url;
    const { text } = await verifiedFetch(fetchUrl, integrity, fetchUrl);
    return { text, source: fetchUrl };
  }

  resolveRelative(base: string, relative: string): string {
    const baseDir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, baseDir).href;
  }

  /** A plain URL cannot be listed, so whatever answers is a file. HEAD, because
   *  a ranged read of a compressed response is not decodable. */
  async entryAt(base: string, relative: string): Promise<"file" | undefined> {
    const url = this.locate(base, relative);
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404) return undefined;
    if (response.ok) return "file";
    // A server that refuses HEAD is asked for the file's first byte instead.
    if (response.status === 405 || response.status === 501) {
      return (await this.readHead(base, relative, 1)) === undefined ? undefined : "file";
    }
    throw new Error(`Failed to read ${url}: ${response.status} ${response.statusText}`);
  }

  async readHead(base: string, relative: string, length: number): Promise<Uint8Array | undefined> {
    const url = this.locate(base, relative);
    // `identity`: a partial compressed body cannot be decoded, and the head is read as stored.
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${Math.max(length, 1) - 1}`, "Accept-Encoding": "identity" },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Failed to read ${url}: ${response.status} ${response.statusText}`);
    }
    // A server that ignores `Range` sends the whole file: take the head, drop the rest.
    const head = new Uint8Array(length);
    let filled = 0;
    const reader = response.body?.getReader();
    while (reader && filled < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, length - filled);
      head.set(value.subarray(0, take), filled);
      filled += take;
    }
    await reader?.cancel();
    return head.subarray(0, filled);
  }

  locate(base: string, relative: string): string {
    return this.resolveRelative(base, relative);
  }
}
