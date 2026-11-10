import { afterEach, describe, expect, it, vi } from "vitest";
import {
  galleryBaseUrlFor,
  galleryCandidates,
  galleryVersionOf,
  loadStarterGallery,
  StarterGalleryUnavailableError,
} from "./starter-gallery";

const CATALOG = ["0.133.0", "0.132.0", "0.131.0"];
const BODY = { starters: [{ id: "a", title: "A", description: "", category: "app", path: "a/telo.yaml" }] };

/** Answers per base URL: a status number, or "throw" for a network failure. */
function stubTags(answers: Record<string, number | "throw">): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const answer = answers[url.replace(/\/starters\.json$/, "")] ?? 404;
      if (answer === "throw") throw new TypeError("Failed to fetch");
      return { ok: answer === 200, status: answer, statusText: "", json: async () => BODY } as Response;
    }),
  );
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("galleryCandidates", () => {
  it("starts at a final version and walks older finals", () => {
    expect(galleryCandidates({ version: "0.132.0" }, CATALOG)).toEqual(["0.132.0", "0.131.0"]);
  });

  it("starts a prerelease or unreleased version from the newest final", () => {
    expect(galleryCandidates({ version: "0.134.0-rc.1" }, CATALOG)).toEqual(CATALOG);
    expect(galleryCandidates({ version: "0.134.0+unreleased" }, CATALOG)).toEqual(CATALOG);
  });

  it("starts the first-run answer from the newest final", () => {
    expect(galleryCandidates({ newest: true }, CATALOG)).toEqual(CATALOG);
  });

  it("has no candidate for an unknown version", () => {
    expect(galleryCandidates(null, CATALOG)).toEqual([]);
  });
});

describe("loadStarterGallery", () => {
  it("uses a fixed base URL as is, with no per-version resolution", async () => {
    const asked = stubTags({ "https://x.dev/g": 200 });
    const gallery = await loadStarterGallery({ fixedBaseUrl: "https://x.dev/g", version: { version: "0.133.0" }, catalogVersions: CATALOG });
    expect(asked).toEqual(["https://x.dev/g/starters.json"]);
    expect(gallery.baseUrl).toBe("https://x.dev/g");
    expect(gallery.version).toBeUndefined();
  });

  it("loads the tag of the version", async () => {
    stubTags({ [galleryBaseUrlFor("0.133.0")]: 200 });
    const gallery = await loadStarterGallery({ fixedBaseUrl: undefined, version: { version: "0.133.0" }, catalogVersions: CATALOG });
    expect(gallery).toMatchObject({ baseUrl: galleryBaseUrlFor("0.133.0"), version: "0.133.0" });
  });

  it("falls back to the next older final on a 404", async () => {
    const asked = stubTags({ [galleryBaseUrlFor("0.131.0")]: 200 });
    const gallery = await loadStarterGallery({ fixedBaseUrl: undefined, version: { version: "0.133.0" }, catalogVersions: CATALOG });
    expect(gallery.version).toBe("0.131.0");
    expect(asked).toHaveLength(3);
  });

  it("says no gallery is published when every tag answers 404", async () => {
    stubTags({});
    await expect(
      loadStarterGallery({ fixedBaseUrl: undefined, version: { version: "0.133.0" }, catalogVersions: CATALOG }),
    ).rejects.toThrow(/No starter gallery is published for telo 0\.133\.0/);
  });

  it("surfaces a failure that is not a 404 instead of trying an older version", async () => {
    const asked = stubTags({ [galleryBaseUrlFor("0.133.0")]: "throw", [galleryBaseUrlFor("0.132.0")]: 200 });
    await expect(
      loadStarterGallery({ fixedBaseUrl: undefined, version: { version: "0.133.0" }, catalogVersions: CATALOG }),
    ).rejects.toThrow(/Could not fetch starter catalog/);
    expect(asked).toHaveLength(1);
  });

  it("fetches nothing when the version is unknown", async () => {
    const asked = stubTags({});
    await expect(
      loadStarterGallery({ fixedBaseUrl: undefined, version: null, catalogVersions: CATALOG }),
    ).rejects.toBeInstanceOf(StarterGalleryUnavailableError);
    expect(asked).toEqual([]);
  });
});

describe("galleryVersionOf", () => {
  const running = (teloVersion: string, version?: string) =>
    ({ kind: "running", teloVersion, status: { version } }) as const;

  it("is the newest final with no workspace open", () => {
    expect(galleryVersionOf({ workspaceOpen: false, hasModule: false, language: null })).toEqual({ newest: true });
  });

  it("is unknown while the language session has not answered", () => {
    expect(galleryVersionOf({ workspaceOpen: true, hasModule: true, language: null })).toBeNull();
    expect(galleryVersionOf({ workspaceOpen: true, hasModule: true, language: running("auto") })).toBeNull();
  });

  it("follows the pin, else the module's resolved version, else the newest final", () => {
    expect(galleryVersionOf({ workspaceOpen: true, hasModule: true, language: running("0.130.0", "0.133.0") })).toEqual({ version: "0.130.0" });
    expect(galleryVersionOf({ workspaceOpen: true, hasModule: true, language: running("auto", "0.133.0") })).toEqual({ version: "0.133.0" });
    expect(galleryVersionOf({ workspaceOpen: true, hasModule: false, language: running("auto") })).toEqual({ newest: true });
  });
});
