import { describe, expect, it } from "vitest";
import type {
  ImportKind,
  LibraryManifest,
  ParsedManifest,
  ParsedResource,
  Workspace,
} from "../model";
import { getAvailableKinds } from "./queries";

function library(
  filePath: string,
  name: string,
  options: {
    categories?: string[];
    imports?: Array<{ name: string; resolvedPath: string }>;
    resources?: ParsedResource[];
  } = {},
): LibraryManifest {
  return {
    filePath,
    kind: "Library",
    metadata: { name, ...(options.categories ? { categories: options.categories } : {}) },
    imports: (options.imports ?? []).map((i) => ({
      name: i.name,
      source: i.resolvedPath,
      importKind: "local" as ImportKind,
      resolvedPath: i.resolvedPath,
    })),
    resources: options.resources ?? [],
  };
}

function definition(
  name: string,
  fields: Record<string, unknown>,
  categories?: string[],
): ParsedResource {
  return { kind: "Telo.Definition", name, fields, ...(categories ? { categories } : {}) };
}

/** A consumer importing every given library under a PascalCase alias. */
function consumer(modules: ParsedManifest[]): { workspace: Workspace; manifest: ParsedManifest } {
  const workspace: Workspace = {
    rootDir: "/ws",
    modules: new Map(modules.map((m) => [m.filePath, m])),
    importGraph: new Map(),
    importedBy: new Map(),
    documents: new Map(),
    resourceDocIndex: new Map(),
  };
  const manifest: ParsedManifest = {
    filePath: "/ws/app/telo.yaml",
    kind: "Application",
    metadata: { name: "app" },
    targets: [],
    imports: modules.map((m) => ({
      name: m.metadata.name.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()),
      source: m.filePath,
      importKind: "local" as ImportKind,
      resolvedPath: m.filePath,
    })),
    resources: [],
  };
  return { workspace, manifest };
}

describe("getAvailableKinds", () => {
  it("resolves a contract through the DECLARING library's aliases, not the consumer's", () => {
    const cache = library("/ws/cache/telo.yaml", "cache", {
      categories: ["storage"],
      resources: [definition("Store", { capability: "Telo.Provider" })],
    });
    // The backend calls its import `Upstream`; the consumer below never uses
    // that alias, so a consumer-scoped lookup would resolve to nothing.
    const redis = library("/ws/cache-redis/telo.yaml", "cache-redis", {
      categories: ["storage", "performance"],
      imports: [{ name: "Upstream", resolvedPath: "/ws/cache/telo.yaml" }],
      resources: [definition("Store", { capability: "Telo.Provider", extends: "Upstream.Store" })],
    });

    const { workspace, manifest } = consumer([cache, redis]);
    const kinds = getAvailableKinds(workspace, manifest);
    const backend = kinds.find((k) => k.fullKind === "CacheRedis.Store");

    expect(backend?.contract).toBe("cache.Store");
    expect(backend?.categories).toEqual(["storage", "performance"]);
  });

  it("resolves `Self` to the declaring library itself", () => {
    const codec = library("/ws/codec/telo.yaml", "codec", {
      resources: [
        definition("Encoder", { capability: "Telo.Invocable" }),
        definition("JsonEncoder", { capability: "Telo.Invocable", extends: "Self.Encoder" }),
      ],
    });

    const { workspace, manifest } = consumer([codec]);
    const kinds = getAvailableKinds(workspace, manifest);

    expect(kinds.find((k) => k.fullKind === "Codec.JsonEncoder")?.contract).toBe("codec.Encoder");
  });

  it("leaves the contract unset for a built-in abstract, which owns no module", () => {
    const stream = library("/ws/record-stream/telo.yaml", "record-stream", {
      resources: [definition("Sink", { capability: "Telo.Sink", extends: "Telo.LogSink" })],
    });

    const { workspace, manifest } = consumer([stream]);
    const kinds = getAvailableKinds(workspace, manifest);

    expect(kinds.find((k) => k.fullKind === "RecordStream.Sink")?.contract).toBeUndefined();
  });

  it("falls back to the module's categories, and lets a kind override them", () => {
    const run = library("/ws/run/telo.yaml", "run", {
      categories: ["compute"],
      resources: [
        definition("Sequence", { capability: "Telo.Runnable" }),
        definition("Retry", { capability: "Telo.Invocable" }, ["reliability"]),
      ],
    });

    const { workspace, manifest } = consumer([run]);
    const kinds = getAvailableKinds(workspace, manifest);

    expect(kinds.find((k) => k.fullKind === "Run.Sequence")?.categories).toEqual(["compute"]);
    expect(kinds.find((k) => k.fullKind === "Run.Retry")?.categories).toEqual(["reliability"]);
  });
});
