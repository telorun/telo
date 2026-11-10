import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../model";
import {
  fetchStarterCatalog,
  fixedStartersBaseUrl,
  StarterCatalogNotFoundError,
  rewriteMetadataName,
  starterManifestUrl,
} from "./starters";

function settings(over?: Partial<AppSettings>): AppSettings {
  return { runners: [], activeRunnerId: "x", ...over } as AppSettings;
}

function stubFetch(impl: (url: string) => Partial<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = impl(url);
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        statusText: r.statusText ?? "OK",
        json: r.json ?? (async () => ({})),
        text: r.text ?? (async () => ""),
        ...r,
      } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fixedStartersBaseUrl", () => {
  it("is undefined when neither the setting nor the build names one", () => {
    expect(fixedStartersBaseUrl(settings(), undefined)).toBeUndefined();
    expect(fixedStartersBaseUrl(settings({ startersBaseUrl: "   " }), undefined)).toBeUndefined();
  });

  it("takes the build's URL when the setting is empty", () => {
    expect(fixedStartersBaseUrl(settings(), "https://b.dev/s")).toBe("https://b.dev/s");
  });

  it("prefers the setting and trims trailing slashes", () => {
    expect(
      fixedStartersBaseUrl(settings({ startersBaseUrl: "https://x.dev/t//" }), "https://b.dev/s"),
    ).toBe("https://x.dev/t");
  });
});

describe("starterManifestUrl", () => {
  it("joins base and path without doubling slashes", () => {
    const url = starterManifestUrl("https://x.dev/", {
      id: "http-api",
      title: "HTTP API",
      description: "",
      category: "app",
      path: "apps/http-api/telo.yaml",
    });
    expect(url).toBe("https://x.dev/apps/http-api/telo.yaml");
  });
});

describe("fetchStarterCatalog", () => {
  it("returns the starters array from starters.json", async () => {
    stubFetch((url) => ({
      ok: url === "https://x.dev/starters.json",
      json: async () => ({
        starters: [
          { id: "a", title: "A", description: "", category: "app", path: "apps/a/telo.yaml" },
        ],
      }),
    }));
    const catalog = await fetchStarterCatalog("https://x.dev");
    expect(catalog.starters).toHaveLength(1);
    expect(catalog.starters[0].id).toBe("a");
  });

  it("throws a not-found error on 404", async () => {
    stubFetch(() => ({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(fetchStarterCatalog("https://x.dev")).rejects.toBeInstanceOf(
      StarterCatalogNotFoundError,
    );
  });

  it("throws on another non-OK status", async () => {
    stubFetch(() => ({ ok: false, status: 500, statusText: "Server Error" }));
    await expect(fetchStarterCatalog("https://x.dev")).rejects.toThrow(/HTTP 500/);
  });

  it("throws on a malformed body", async () => {
    stubFetch(() => ({ json: async () => ({ nope: true }) }));
    await expect(fetchStarterCatalog("https://x.dev")).rejects.toThrow(/malformed/);
  });

  it("throws an actionable error on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchStarterCatalog("https://x.dev")).rejects.toThrow(
      /Could not fetch starter catalog/,
    );
  });
});

describe("rewriteMetadataName", () => {
  it("rewrites the root Application's metadata.name", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: OldName\n  version: 1.0.0\n";
    const out = rewriteMetadataName("/t/telo.yaml", text, "NewName");
    expect(out).toContain("name: NewName");
    expect(out).not.toContain("OldName");
  });

  it("preserves !cel tags in the rest of the document", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: Old\n---\nkind: Http.Server\nmetadata:\n  name: S\nport: !cel \"ports.http\"\n";
    const out = rewriteMetadataName("/t/telo.yaml", text, "New");
    expect(out).toContain("!cel");
    expect(out).toContain("name: New");
  });

  it("is a no-op when no Application/Library document is present", () => {
    const text = "kind: Http.Api\nmetadata:\n  name: Something\n";
    expect(rewriteMetadataName("/t/telo.yaml", text, "NewName")).toBe(text);
  });
});
