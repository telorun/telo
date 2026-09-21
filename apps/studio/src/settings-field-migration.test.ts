import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./storage";
import { LOCAL_KEYS } from "./storage-keys";

beforeEach(() => {
  window.localStorage.clear();
});

describe("settings field migration", () => {
  it("reads a stored templatesBaseUrl as startersBaseUrl", () => {
    window.localStorage.setItem(
      LOCAL_KEYS.settings,
      JSON.stringify({ templatesBaseUrl: "https://x.dev/gallery" }),
    );
    const settings = loadSettings() as unknown as Record<string, unknown>;
    expect(settings.startersBaseUrl).toBe("https://x.dev/gallery");
    expect("templatesBaseUrl" in settings).toBe(false);
  });

  it("keeps a startersBaseUrl already stored over the legacy field", () => {
    window.localStorage.setItem(
      LOCAL_KEYS.settings,
      JSON.stringify({ templatesBaseUrl: "https://old.dev", startersBaseUrl: "https://new.dev" }),
    );
    expect(loadSettings()?.startersBaseUrl).toBe("https://new.dev");
  });
});
