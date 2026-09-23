import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import type { CachedYamlParse, YamlParseCache } from "../src/yaml-parse-cache.js";

const APP = `kind: Telo.Application
metadata:
  name: App
imports:
  Console: ./console
targets:
  - !ref hello
---
kind: Console.WriteLine
metadata:
  name: hello
message: !cel "'hi ' + variables.name"
`;

const URL = "file:///app/telo.yaml";

function source(text: string): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => relative,
  };
}

function memoryCache(): YamlParseCache & { entries: Map<string, CachedYamlParse> } {
  const entries = new Map<string, CachedYamlParse>();
  return {
    entries,
    read(source, text) {
      // A store hands back a copy, never the object it was given.
      const hit = entries.get(`${source}\0${text}`);
      return hit && structuredClone(hit);
    },
    write(source, text, parse) {
      entries.set(`${source}\0${text}`, structuredClone(parse));
    },
  };
}

async function load(cache: YamlParseCache | undefined, text = APP) {
  const loader = new Loader([source(text)]);
  loader.setParseCache(cache);
  return loader.loadFile(URL, { desugarImports: true, migrate: true });
}

describe("YAML parse cache", () => {
  it("restores a load identical to parsing it", async () => {
    const cache = memoryCache();
    const parsed = await load(cache);
    expect(cache.entries.size).toBe(1);

    const restored = await load(cache);
    expect(restored.manifests).toEqual(parsed.manifests);
    expect(restored.positions).toEqual(parsed.positions);
    expect(restored.parseErrors).toEqual([]);
    expect(cache.entries.size).toBe(1);
  });

  it("parses a restored file's YAML documents only when they are read", async () => {
    const cache = memoryCache();
    await load(cache);
    const restored = await load(cache);

    expect(Object.getOwnPropertyDescriptor(restored, "documents")?.get).toBeTypeOf("function");
    expect(restored.documents.map((doc) => doc.toJSON())).toEqual(
      (await load(undefined)).documents.map((doc) => doc.toJSON()),
    );
    expect(restored.astDocuments).toHaveLength(2);
  });

  it("never records a parse that reported errors", async () => {
    const cache = memoryCache();
    const broken = `kind: Telo.Application\nmetadata: [unclosed\n`;
    const file = await load(cache, broken);
    expect(file.parseErrors.length).toBeGreaterThan(0);
    expect(cache.entries.size).toBe(0);
  });
});
