import { describe, expect, it } from "vitest";
import {
  type KindRuntimeEntry,
  kindRuntimeSupport,
  moduleRuntimeReport,
} from "../src/controller-runtime.js";

/** The PURL-to-kernel mapping is a HAND-MAINTAINED mirror of what the loaders
 *  dispatch on (`dispatchResolveOne` and the bundle-loader's format gate in
 *  `kernel/nodejs/src/`, `dispatch_one` in `kernel/rust/src/`). Nothing derives
 *  it from them — the Rust half cannot be imported from here at all — so these
 *  cases pin the mapping per PURL type rather than only through the roll-up, and
 *  a loader change has to be reflected here by hand.
 *
 *  What that protects: a drift makes the hub claim a kind runs on a kernel that
 *  cannot load it, which is the one failure this facet exists to prevent. */

const JS = "pkg:telo/local/js?path=./nodejs/x.mjs&local_path=./nodejs/src/x.ts";
const CARGO = "pkg:cargo/telorun-console?local_path=./rust#writeline_controller";
const NPM = "pkg:npm/@telorun/starlark@0.5.0?local_path=./nodejs#script";

describe("kindRuntimeSupport", () => {
  it("gives a cargo controller both kernels — Node builds it as a napi addon", () => {
    expect(kindRuntimeSupport([CARGO])).toEqual({
      runtimes: ["nodejs", "rust"],
      languages: ["rust"],
      portable: false,
    });
  });

  it("keeps npm and bundled js on the Node kernel only", () => {
    for (const purl of [NPM, JS]) {
      expect(kindRuntimeSupport([purl])).toEqual({
        runtimes: ["nodejs"],
        languages: ["javascript"],
        portable: false,
      });
    }
  });

  it("unions the candidate list rather than taking the first", () => {
    expect(kindRuntimeSupport([JS, CARGO])).toEqual({
      runtimes: ["nodejs", "rust"],
      languages: ["javascript", "rust"],
      portable: false,
    });
  });

  it("claims no language for a bundle format whose source language is unknowable", () => {
    // A `.node` addon may be Rust, C++ or Zig — and no kernel hosts the format
    // today, so it names no runtime either. A blank beats a guess.
    expect(kindRuntimeSupport(["pkg:telo/local/napi?path=./rust/x.node"])).toEqual({
      runtimes: [],
      languages: [],
      portable: false,
    });
  });

  it("hosts nothing for a non-local pkg:telo namespace or an unparseable PURL", () => {
    for (const purl of ["pkg:telo/registry/js?path=./x.mjs", "not-a-purl"]) {
      expect(kindRuntimeSupport([purl]).runtimes).toEqual([]);
    }
  });

  it("separates 'no controllers' from 'controllers no kernel hosts'", () => {
    // Both have an empty runtime list, and they mean opposite things: the first
    // runs everywhere, the second nowhere. Only the flag tells them apart.
    expect(kindRuntimeSupport([]).portable).toBe(true);
    expect(kindRuntimeSupport(["pkg:telo/local/wasm?path=./x.wasm"]).portable).toBe(false);
  });
});

describe("moduleRuntimeReport", () => {
  const kind = (name: string, controllers: string[]): KindRuntimeEntry => ({
    name,
    ...kindRuntimeSupport(controllers),
  });

  it("reports partial coverage when only some kinds reach a kernel", () => {
    // The `std/console` shape: Rust controllers on two of four kinds. A boolean
    // would claim the whole module runs on the Rust kernel, which is false.
    const report = moduleRuntimeReport([
      kind("WriteLine", [JS, CARGO]),
      kind("ReadLine", [JS, CARGO]),
      kind("WriteStream", [JS]),
      kind("StreamWait", [JS]),
    ]);
    expect(report.runtimes).toEqual({ nodejs: "full", rust: "partial" });
    expect(report.languages).toEqual(["javascript", "rust"]);
    expect(report.portable).toBe(false);
  });

  it("counts a portable kind as supported on every kernel", () => {
    const report = moduleRuntimeReport([kind("Store", []), kind("Get", [JS])]);
    expect(report.runtimes).toEqual({ nodejs: "full", rust: "partial" });
    expect(report.portable).toBe(false);
  });

  it("marks a module with no controller code portable", () => {
    const report = moduleRuntimeReport([kind("Store", []), kind("Entry", [])]);
    expect(report).toMatchObject({ portable: true, languages: [] });
  });

  it("omits a kernel that hosts none of the kinds", () => {
    expect(moduleRuntimeReport([kind("Api", [JS])]).runtimes).toEqual({ nodejs: "full" });
  });

  it("treats a manifest with no kinds as vacuously portable", () => {
    expect(moduleRuntimeReport([])).toEqual({
      kinds: [],
      languages: [],
      runtimes: {},
      portable: true,
    });
  });
});
