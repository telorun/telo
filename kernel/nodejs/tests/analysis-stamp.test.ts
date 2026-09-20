import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedGraph } from "@telorun/analyzer";
import {
  computeAnalysisSignature,
  readAnalysisStamp,
  writeAnalysisStamp,
} from "../src/manifest-sources/analysis-stamp.js";

/**
 * One stamp per entry.
 *
 * The single-file layout this replaced was per-app only because every app used to
 * get its own `.telo` beside its manifest. Once the cache root is shared across a
 * workspace, one file means each app overwrites the last — A stamps, B misses and
 * overwrites, forever. That is a permanent 100% miss that reports nothing and
 * simply makes every boot slower, so the alternation below is the regression it
 * exists to catch.
 */

let analysisDir: string;

beforeEach(async () => {
  analysisDir = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "telo-stamp-")),
    "analysis",
  );
});

afterEach(async () => {
  await fs.rm(path.dirname(analysisDir), { recursive: true, force: true });
});

describe("analysis stamp", () => {
  it("keeps one entry's verdict when another entry stamps", async () => {
    const a = "file:///ws/a/telo.yaml";
    const b = "file:///ws/b/telo.yaml";

    await writeAnalysisStamp(a, "sig-a", analysisDir);
    await writeAnalysisStamp(b, "sig-b", analysisDir);

    expect((await readAnalysisStamp(a, analysisDir))?.signature).toBe("sig-a");
    expect((await readAnalysisStamp(b, analysisDir))?.signature).toBe("sig-b");
    expect(await fs.readdir(analysisDir)).toHaveLength(2);
  });

  it("misses for an entry that has never been stamped", async () => {
    await writeAnalysisStamp("file:///ws/a/telo.yaml", "sig-a", analysisDir);

    expect(await readAnalysisStamp("file:///ws/other/telo.yaml", analysisDir)).toBeUndefined();
  });

  it("separates two manifests sitting in one directory", async () => {
    // Keyed by entry URL, not by its directory: an app and its test harness are
    // two entries with two verdicts, and a shared root makes the directory a far
    // weaker discriminator than it was.
    await writeAnalysisStamp("file:///ws/app.telo.yaml", "sig-app", analysisDir);
    await writeAnalysisStamp("file:///ws/suite.telo.yaml", "sig-suite", analysisDir);

    expect((await readAnalysisStamp("file:///ws/app.telo.yaml", analysisDir))?.signature).toBe(
      "sig-app",
    );
    expect((await readAnalysisStamp("file:///ws/suite.telo.yaml", analysisDir))?.signature).toBe(
      "sig-suite",
    );
  });

  describe("a packaged application's signature", () => {
    // A payload is unpacked at a digest-keyed path that has nothing to do with
    // where it was built, so the ordinary identity — each file's absolute source
    // URL — moves and every start re-runs the whole validation walk, silently.
    const graph = (root: string, body = "kind: Telo.Application\n"): LoadedGraph =>
      ({
        modules: new Map([
          [
            "app",
            {
              owner: { source: `${root}/telo.yaml`, text: body },
              partials: [{ source: `${root}/lib/telo.yaml`, text: "kind: Telo.Library\n" }],
            },
          ],
          [
            "console",
            {
              owner: {
                source: "/some/cache/manifests/oci/ghcr.io/telorun/console/1.0.0/telo.yaml",
                requestedUrl: "oci://ghcr.io/telorun/console@1.0.0#sha256-abc",
                text: "kind: Telo.Library\n",
              },
              partials: [],
            },
          ],
        ]),
      }) as unknown as LoadedGraph;

    const BUILT = "/build/app";
    const UNPACKED = "/home/u/.cache/telo/apps/App-abc/app";

    it("survives relocation, so the verdict is hit where the payload is unpacked", () => {
      expect(computeAnalysisSignature(graph(BUILT))).not.toBe(
        computeAnalysisSignature(graph(UNPACKED)),
      );
      expect(
        computeAnalysisSignature(graph(BUILT), {
          appKey: "payload-key",
          entryUrl: `${BUILT}/telo.yaml`,
        }),
      ).toBe(
        computeAnalysisSignature(graph(UNPACKED), {
          appKey: "payload-key",
          entryUrl: `${UNPACKED}/telo.yaml`,
        }),
      );
    });

    it("still covers file CONTENT, so an edited tree does not hit a stamp", () => {
      // The verdict is about the files the kernel actually loaded. Keyed on the
      // payload alone it would be a verdict about the PAYLOAD while the load is
      // from an unpacked TREE — and a tree truncated by a full disk or
      // half-restored from a backup would boot a manifest nothing validated.
      const key = { appKey: "payload-key", entryUrl: `${UNPACKED}/telo.yaml` };
      const clean = computeAnalysisSignature(graph(UNPACKED), key);
      const edited = computeAnalysisSignature(
        graph(UNPACKED, "kind: Telo.Application\n# edited after unpacking\n"),
        key,
      );
      expect(edited).not.toBe(clean);
    });

    it("is a verdict about one payload, not any payload", () => {
      const entryUrl = `${UNPACKED}/telo.yaml`;
      expect(computeAnalysisSignature(graph(UNPACKED), { appKey: "a", entryUrl })).not.toBe(
        computeAnalysisSignature(graph(UNPACKED), { appKey: "b", entryUrl }),
      );
    });
  });

  it("reads nothing from a pre-workspace-anchor stamp file", async () => {
    // The old layout is a FILE where this one wants a directory, so neither
    // version of the kernel can misread the other's — no migration needed.
    await fs.mkdir(path.dirname(analysisDir), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(analysisDir), ".validated.json"),
      JSON.stringify({ version: 1, signature: "stale" }),
    );

    expect(await readAnalysisStamp("file:///ws/a/telo.yaml", analysisDir)).toBeUndefined();
  });
});
