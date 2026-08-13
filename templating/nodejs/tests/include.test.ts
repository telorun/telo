import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import {
  defaultCustomTags,
  defaultRegistry,
  includeBytesEngine,
  includeTextEngine,
  isIncludeSentinel,
  isTaggedSentinel,
  normalizeIncludePath,
} from "../src/index.js";

const analyze = (engine: typeof includeTextEngine, source: string) =>
  engine.analyze(source, { celEnv: {} as never, contextSchema: null }).diagnostics;

describe("normalizeIncludePath", () => {
  it("folds `./` and `.` segments to a root-relative path", () => {
    expect(normalizeIncludePath("assets/logo.svg").path).toBe("assets/logo.svg");
    expect(normalizeIncludePath("./assets/logo.svg").path).toBe("assets/logo.svg");
    expect(normalizeIncludePath("assets/./logo.svg").path).toBe("assets/logo.svg");
  });

  it("resolves an interior `..` without escaping", () => {
    expect(normalizeIncludePath("assets/fonts/../logo.svg").path).toBe("assets/logo.svg");
  });

  it("normalizes backslash separators, so a Windows-authored path claims the same file", () => {
    expect(normalizeIncludePath("assets\\logo.svg").path).toBe("assets/logo.svg");
  });

  it("rejects a path above the module root", () => {
    const { path, diagnostic } = normalizeIncludePath("../outside.txt");
    expect(path).toBeUndefined();
    expect(diagnostic?.code).toBe("INCLUDE_PATH_ESCAPES_MODULE");
  });

  it("rejects a `..` that escapes only after descending", () => {
    expect(normalizeIncludePath("assets/../../outside.txt").diagnostic?.code).toBe(
      "INCLUDE_PATH_ESCAPES_MODULE",
    );
  });

  it("rejects absolute paths", () => {
    expect(normalizeIncludePath("/etc/passwd").diagnostic?.code).toBe(
      "INCLUDE_PATH_ESCAPES_MODULE",
    );
  });

  it("rejects a URL, pointing at Fs.File instead", () => {
    const { diagnostic } = normalizeIncludePath("https://example.com/logo.svg");
    expect(diagnostic?.code).toBe("INCLUDE_PATH_INVALID");
    expect(diagnostic?.message).toContain("Fs.File");
  });

  it("rejects a glob, because a claim must name one file", () => {
    expect(normalizeIncludePath("assets/*.svg").diagnostic?.code).toBe("INCLUDE_PATH_INVALID");
  });

  it("rejects an empty path and one that resolves to the root", () => {
    expect(normalizeIncludePath("").diagnostic?.code).toBe("INCLUDE_PATH_INVALID");
    expect(normalizeIncludePath("./").diagnostic?.code).toBe("INCLUDE_PATH_INVALID");
  });
});

describe("include engines", () => {
  it("are registered under their tag names", () => {
    expect(defaultRegistry().get("include-text")).toBe(includeTextEngine);
    expect(defaultRegistry().get("include-bytes")).toBe(includeBytesEngine);
  });

  it("compile to a sentinel, so the value survives precompile unresolved", () => {
    const compiled = includeBytesEngine.compile("assets/logo.png", { celEnv: {} as never });
    expect(isIncludeSentinel(compiled)).toBe(true);
    expect(isTaggedSentinel(compiled) && compiled.source).toBe("assets/logo.png");
  });

  it("claim the normalized path, and only the path", () => {
    // Which artifact layer the file belongs in is packaging's vocabulary, not
    // this package's — the analyzer assigns it, alongside the roles it already
    // assigns for controller candidates.
    expect(includeTextEngine.fileClaims?.("./assets/bg.svg")).toEqual([{ path: "assets/bg.svg" }]);
  });

  it("claim nothing for a path analyze rejects, so publish reports it once", () => {
    expect(includeBytesEngine.fileClaims?.("../outside.bin")).toEqual([]);
    expect(analyze(includeBytesEngine, "../outside.bin")).toHaveLength(1);
  });

  it("accept a valid path with no diagnostics", () => {
    expect(analyze(includeTextEngine, "assets/bg.svg")).toEqual([]);
  });

  it("report no calls — there is no expression language here", () => {
    const result = includeTextEngine.analyze("assets/bg.svg", {
      celEnv: {} as never,
      contextSchema: null,
    });
    expect(result.calls).toEqual([]);
  });
});

describe("YAML round-trip", () => {
  const parse = (src: string) =>
    parseAllDocuments(src, { customTags: defaultCustomTags() })[0]!;

  it("parses both tags into sentinels", () => {
    const json = parse("a: !include-text assets/bg.svg\nb: !include-bytes assets/f.ttf").toJSON();
    expect(isIncludeSentinel(json.a)).toBe(true);
    expect(json.a.engine).toBe("include-text");
    expect(json.b.engine).toBe("include-bytes");
    expect(json.b.source).toBe("assets/f.ttf");
  });

  it("serializes back to the original tag form", () => {
    const src = "a: !include-text assets/bg.svg";
    expect(String(parse(src)).trim()).toBe(src);
  });

  it("does not mistake an include for a ref", () => {
    const json = parse("a: !include-text assets/bg.svg").toJSON();
    expect(isIncludeSentinel(json.a)).toBe(true);
    expect(json.a.engine).not.toBe("ref");
  });
});
