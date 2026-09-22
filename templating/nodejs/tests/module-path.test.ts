import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import {
  defaultCustomTags,
  isModulePathSentinel,
  modulePathEngine,
  normalizeModulePath,
  producedTypeOf,
} from "../src/index.js";

const analyze = (source: string) =>
  modulePathEngine.analyze(source, { celEnv: {} as never, contextSchema: null }).diagnostics;

describe("!module-path", () => {
  it("names a file or a directory relative to the module root", () => {
    expect(normalizeModulePath("./public").path).toBe("public");
    expect(normalizeModulePath("site/../public").path).toBe("public");
    expect(analyze("./public")).toEqual([]);
  });

  it("refuses what cannot ship inside the module, under its own codes", () => {
    expect(analyze("../outside").map((d) => d.code)).toEqual(["MODULE_PATH_ESCAPES_MODULE"]);
    expect(analyze("/srv/www").map((d) => d.code)).toEqual(["MODULE_PATH_ESCAPES_MODULE"]);
    expect(analyze("public/*").map((d) => d.code)).toEqual(["MODULE_PATH_INVALID"]);
    expect(analyze("./").map((d) => d.code)).toEqual(["MODULE_PATH_INVALID"]);
  });

  it("claims the path as a possible directory, so publish and packaging carry what is beneath it", () => {
    expect(modulePathEngine.fileClaims!("./public")).toEqual([{ path: "public", directory: true }]);
    expect(modulePathEngine.fileClaims!("../outside")).toEqual([]);
  });

  it("produces a host path", () => {
    expect(producedTypeOf("module-path")).toEqual({ type: "string", "x-telo-type": "Telo.HostPath" });
  });

  it("parses to a sentinel and serializes back to the tag", () => {
    const src = "root: !module-path ./public";
    const doc = parseAllDocuments(src, { customTags: defaultCustomTags() })[0]!;
    expect(isModulePathSentinel((doc.toJSON() as { root: unknown }).root)).toBe(true);
    expect(String(doc).trim()).toBe(src);
  });
});
