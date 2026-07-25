import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../model";
import {
  DEFAULT_TEMPLATES_BASE_URL,
  fetchTemplateCatalog,
  resolveTemplatesBaseUrl,
  rewriteMetadataName,
  templateManifestUrl,
} from "./templates";

function settings(over?: Partial<AppSettings>): AppSettings {
  return { registryServers: [], runners: [], activeRunnerId: "x", ...over } as AppSettings;
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

describe("resolveTemplatesBaseUrl", () => {
  it("falls back to the public default when unset", () => {
    expect(resolveTemplatesBaseUrl(settings())).toBe(DEFAULT_TEMPLATES_BASE_URL);
  });

  it("treats whitespace-only as unset", () => {
    expect(resolveTemplatesBaseUrl(settings({ templatesBaseUrl: "   " }))).toBe(
      DEFAULT_TEMPLATES_BASE_URL,
    );
  });

  it("uses the setting and trims trailing slashes", () => {
    expect(resolveTemplatesBaseUrl(settings({ templatesBaseUrl: "https://x.dev/t//" }))).toBe(
      "https://x.dev/t",
    );
  });
});

describe("templateManifestUrl", () => {
  it("joins base and path without doubling slashes", () => {
    const url = templateManifestUrl("https://x.dev/", {
      id: "http-api",
      title: "HTTP API",
      description: "",
      category: "app",
      path: "apps/http-api/telo.yaml",
    });
    expect(url).toBe("https://x.dev/apps/http-api/telo.yaml");
  });
});

describe("fetchTemplateCatalog", () => {
  it("returns the templates array", async () => {
    stubFetch(() => ({
      json: async () => ({
        templates: [
          { id: "a", title: "A", description: "", category: "app", path: "apps/a/telo.yaml" },
        ],
      }),
    }));
    const catalog = await fetchTemplateCatalog("https://x.dev");
    expect(catalog.templates).toHaveLength(1);
    expect(catalog.templates[0].id).toBe("a");
  });

  it("throws on a non-OK status", async () => {
    stubFetch(() => ({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(fetchTemplateCatalog("https://x.dev")).rejects.toThrow(/HTTP 404/);
  });

  it("throws on a malformed body", async () => {
    stubFetch(() => ({ json: async () => ({ nope: true }) }));
    await expect(fetchTemplateCatalog("https://x.dev")).rejects.toThrow(/malformed/);
  });

  it("throws an actionable error on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchTemplateCatalog("https://x.dev")).rejects.toThrow(
      /Could not fetch template catalog/,
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
