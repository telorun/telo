import { describe, expect, it } from "vitest";

import type { RunBundle } from "./contract.js";
import { extractDependencyKey } from "./dependency-key.js";

function bundle(manifest: string, extra: RunBundle["files"] = []): RunBundle {
  return {
    entryRelativePath: "manifest.yaml",
    files: [{ relativePath: "manifest.yaml", contents: manifest }, ...extra],
  };
}

const APP = [
  "kind: Telo.Application",
  "metadata:",
  "  name: app",
  "imports:",
  "  Console: std/console@0.9.0",
  "  Http: std/http-server@1.2.0",
  "---",
  "kind: Telo.Definition",
  "metadata:",
  "  name: Thing",
  "controllers:",
  "  - pkg:npm/@acme/thing@1.0.0",
  "",
].join("\n");

describe("extractDependencyKey", () => {
  it("collects imports and body-declared controllers, sorted", () => {
    const key = extractDependencyKey(bundle(APP));
    expect(key.importSources).toEqual(["std/console@0.9.0", "std/http-server@1.2.0"]);
    expect(key.controllerLocators).toEqual(["pkg:npm/@acme/thing@1.0.0"]);
    expect(key.fullContentFallback).toBe(false);
  });

  it("reads the object form of an import entry", () => {
    const m = APP.replace(
      "  Console: std/console@0.9.0",
      "  Console:\n    source: std/console@0.9.0\n    variables: { level: info }",
    );
    expect(extractDependencyKey(bundle(m)).importSources).toContain("std/console@0.9.0");
  });

  it("flags local_path controllers for full-content fallback", () => {
    const m = APP.replace(
      "  - pkg:npm/@acme/thing@1.0.0",
      "  - pkg:npm/@acme/thing@1.0.0\nlocal_path: ./thing",
    );
    expect(extractDependencyKey(bundle(m)).fullContentFallback).toBe(true);
  });

  it("flags an unparseable file for full-content fallback", () => {
    const key = extractDependencyKey(bundle(APP, [{ relativePath: "broken.yaml", contents: "a: b: c: :\n  - [" }]));
    expect(key.fullContentFallback).toBe(true);
  });

  it("returns empty sets for a manifest with no imports or controllers", () => {
    const key = extractDependencyKey(bundle("kind: Telo.Application\nmetadata:\n  name: bare\n"));
    expect(key.importSources).toEqual([]);
    expect(key.controllerLocators).toEqual([]);
    expect(key.fullContentFallback).toBe(false);
  });
});
