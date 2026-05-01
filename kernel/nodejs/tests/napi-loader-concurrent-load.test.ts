import { describe, expect, it } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  NapiControllerLoader,
  __getNapiBuildAttempts,
  __resetNapiLoaderForTest,
} from "../src/controller-loaders/napi-loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Pretend a manifest sits next to this test file; relative `local_path`
// resolves to the real fixture crate at tests/napi-echo.
const fakeManifest = `file://${path.join(here, "fake-manifest.yaml")}`;
const purl = "pkg:cargo/napi-echo?local_path=./napi-echo";

describe("NapiControllerLoader single-flight dedupe", () => {
  it("performs one build/copy/load when many callers race for the same crate", async () => {
    __resetNapiLoaderForTest();
    const loader = new NapiControllerLoader();

    // Five concurrent callers exercise the single-flight gate. Without the
    // dedupe in load(), each would race through `cargo build` + `fs.copyFile`
    // over the same `.node` — the failure mode this test guards against
    // (segfault from finalize callbacks running over torn pages, plus the
    // observable signal that buildAndLoad ran more than once).
    const results = await Promise.all([
      loader.load(purl, fakeManifest),
      loader.load(purl, fakeManifest),
      loader.load(purl, fakeManifest),
      loader.load(purl, fakeManifest),
      loader.load(purl, fakeManifest),
    ]);

    expect(__getNapiBuildAttempts()).toBe(1);

    // Every caller must observe the same underlying module instance — the
    // segfault scenario could in principle mmap two distinct page sets, so
    // identity is the second-tier safety check after the build counter.
    const first = results[0].instance;
    for (const r of results) {
      expect(r.instance).toBe(first);
    }

    // After the in-flight settles, repeat calls hit the populated module
    // cache — proving the cache and the in-flight map cooperated rather
    // than leaking the in-flight entry.
    const followup = await loader.load(purl, fakeManifest);
    expect(followup.source).toBe("cache");
    expect(__getNapiBuildAttempts()).toBe(1);
  });
});
