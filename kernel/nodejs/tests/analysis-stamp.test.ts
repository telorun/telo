import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
