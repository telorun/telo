import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** Counting in-memory source that tracks how many times each URL is read.
 *  Returns a canonical `source` that differs from the requested URL so the
 *  test can distinguish url-keyed cache hits from source-keyed ones. */
function countingSource(files: Record<string, { text: string; source: string }>): {
  source: ManifestSource;
  reads: Map<string, number>;
} {
  const reads = new Map<string, number>();
  return {
    reads,
    source: {
      supports() {
        return true;
      },
      async read(url: string) {
        const file = files[url];
        if (!file) throw new Error(`File not found: ${url}`);
        reads.set(url, (reads.get(url) ?? 0) + 1);
        return file;
      },
      resolveRelative(base: string, relative: string): string {
        return relative.startsWith("/") ? relative : base + relative;
      },
    },
  };
}

describe("Loader.loadFile url cache", () => {
  it("skips the source read on a second call for the same URL", async () => {
    const { source, reads } = countingSource({
      "std/foo@1.0.0": {
        text: "kind: Telo.Library\nmetadata:\n  name: Foo\n  version: 1.0.0\n",
        source: "file:///cache/std/foo/1.0.0/telo.yaml",
      },
    });
    const loader = new Loader({
      extraSources: [source],
      includeHttpSource: false,
      includeRegistrySource: false,
    });

    const first = await loader.loadFile("std/foo@1.0.0");
    const second = await loader.loadFile("std/foo@1.0.0");

    expect(reads.get("std/foo@1.0.0")).toBe(1);
    expect(second).toBe(first); // identity-stable on cache hit
  });

  it("reparses from cached text when the compile mode differs", async () => {
    const { source, reads } = countingSource({
      "std/bar@1.0.0": {
        text: "kind: Telo.Library\nmetadata:\n  name: Bar\n  version: 1.0.0\n",
        source: "file:///cache/std/bar/1.0.0/telo.yaml",
      },
    });
    const loader = new Loader({
      extraSources: [source],
      includeHttpSource: false,
      includeRegistrySource: false,
    });

    await loader.loadFile("std/bar@1.0.0", { compile: false });
    await loader.loadFile("std/bar@1.0.0", { compile: true });

    // Same URL, different compile mode — the second call must not re-fetch.
    expect(reads.get("std/bar@1.0.0")).toBe(1);
  });

  it("issues exactly one read per distinct URL across loadGraph + loadModule cycles", async () => {
    const { source, reads } = countingSource({
      "app.yaml": {
        text: [
          "kind: Telo.Application",
          "metadata:",
          "  name: App",
          "  version: 1.0.0",
          "---",
          "kind: Telo.Import",
          "metadata:",
          "  name: Foo",
          "source: std/foo@1.0.0",
          "",
        ].join("\n"),
        source: "file:///app.yaml",
      },
      "std/foo@1.0.0": {
        text: "kind: Telo.Library\nmetadata:\n  name: Foo\n  version: 1.0.0\n",
        source: "file:///cache/std/foo/1.0.0/telo.yaml",
      },
    });
    const loader = new Loader({
      extraSources: [source],
      includeHttpSource: false,
      includeRegistrySource: false,
    });

    await loader.loadGraph("app.yaml");
    await loader.loadModule("std/foo@1.0.0", { compile: true });

    expect(reads.get("app.yaml")).toBe(1);
    expect(reads.get("std/foo@1.0.0")).toBe(1);
  });
});
