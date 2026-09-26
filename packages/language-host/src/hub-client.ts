import type { HubRef, ModuleVersion } from "@telorun/editor-protocol";

/** Where the telo hub is — read per lookup, so a changed setting applies to the
 *  next one. */
export interface HubEndpoint {
  url(): string;
  fetch?: typeof globalThis.fetch;
}

const CANONICAL_PIN = /^sha256-[A-Za-z0-9_-]{43}$/;

/**
 * The hub's two answers an engine asks its host for, read the one way every
 * host reads them. Parsing is lenient where the hub's shape can drift — an
 * entry with no usable version is dropped, and an `integrity` that is not a
 * canonical `sha256-<base64url>` pin is discarded rather than carried, since a
 * pin is spliced into an author's YAML — and strict where it cannot: an
 * unreachable hub or a failed answer rejects with a reason naming the hub.
 */
export class HubClient {
  constructor(private readonly endpoint: HubEndpoint) {}

  /** Every version the hub tracks for a location ref, newest first, in the
   *  route's own order (`GET /module/versions?ref=`); `[]` for a ref it does
   *  not track. */
  async listVersions(ref: string): Promise<ModuleVersion[]> {
    const url = `${this.base()}/module/versions?ref=${encodeURIComponent(ref)}`;
    const response = await this.get(url);
    if (response.status === 404) return [];
    const versions = ((await this.json(response, url)) as { versions?: unknown } | null)?.versions;
    if (!Array.isArray(versions)) return [];
    return versions.flatMap((entry): ModuleVersion[] => {
      const version = (entry as { version?: unknown } | null)?.version;
      if (typeof version !== "string" || version === "") return [];
      const integrity = (entry as { integrity?: unknown }).integrity;
      return [typeof integrity === "string" && CANONICAL_PIN.test(integrity) ? { version, integrity } : { version }];
    });
  }

  /** Refs the hub matches `query` against (`GET /refs?q=`). */
  async searchRefs(query: string): Promise<HubRef[]> {
    const url = `${this.base()}/refs?q=${encodeURIComponent(query)}`;
    const refs = ((await this.json(await this.get(url), url)) as { refs?: unknown } | null)?.refs;
    if (!Array.isArray(refs)) return [];
    return refs.flatMap((entry): HubRef[] => {
      const { ref, latestVersion, description } = (entry ?? {}) as Record<string, unknown>;
      if (typeof ref !== "string" || ref === "") return [];
      return [
        {
          ref,
          latestVersion: typeof latestVersion === "string" ? latestVersion : "",
          ...(typeof description === "string" ? { description } : {}),
        },
      ];
    });
  }

  private base(): string {
    return this.endpoint.url().replace(/\/+$/, "");
  }

  private async get(url: string): Promise<Response> {
    try {
      return await (this.endpoint.fetch ?? globalThis.fetch)(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new Error(
        `could not reach the telo hub at ${this.base()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async json(response: Response, url: string): Promise<unknown> {
    if (!response.ok) {
      throw new Error(`the telo hub answered HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `the telo hub at ${this.base()} answered ${url} with something that is not JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
