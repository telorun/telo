import { describe, expect, it } from "vitest";
import type {
  ImportKind,
  LibraryManifest,
  ParsedManifest,
  ParsedResource,
  Workspace,
} from "../model";
import { canonicalizeSchemaRefs, getAvailableKinds, getImportedConfig } from "./queries";

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

  it("inherits the capability an implementation kind omits, across library boundaries", () => {
    const cache = library("/ws/cache/telo.yaml", "cache", {
      resources: [
        { kind: "Telo.Abstract", name: "Store", fields: { capability: "Telo.Provider" } },
      ],
    });
    // Omitting `capability:` to inherit the ancestor's is the sanctioned
    // spelling, so reading the field alone leaves this kind with none.
    const redis = library("/ws/cache-redis/telo.yaml", "cache-redis", {
      imports: [{ name: "Upstream", resolvedPath: "/ws/cache/telo.yaml" }],
      resources: [definition("Store", { extends: "Upstream.Store" })],
    });

    const { workspace, manifest } = consumer([cache, redis]);
    const kinds = getAvailableKinds(workspace, manifest);

    expect(kinds.find((k) => k.fullKind === "CacheRedis.Store")?.capability).toBe("Telo.Provider");
  });

  it("leaves the capability empty when the chain leaves the workspace", () => {
    const stream = library("/ws/record-stream/telo.yaml", "record-stream", {
      resources: [definition("Sink", { extends: "Telo.LogSink" })],
    });

    const { workspace, manifest } = consumer([stream]);
    const kinds = getAvailableKinds(workspace, manifest);

    expect(kinds.find((k) => k.fullKind === "RecordStream.Sink")?.capability).toBe("");
  });

  it("terminates on an `extends` cycle", () => {
    const loop = library("/ws/loop/telo.yaml", "loop", {
      resources: [
        definition("A", { extends: "Self.B" }),
        definition("B", { extends: "Self.A" }),
      ],
    });

    const { workspace, manifest } = consumer([loop]);

    expect(getAvailableKinds(workspace, manifest).find((k) => k.kindName === "A")?.capability).toBe(
      "",
    );
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

describe("canonicalizeSchemaRefs", () => {
  /** postgres declares `Schema.connection` pointing at its OWN `Connection`,
   *  written `Self.Connection` — an alias private to postgres's manifest. */
  function postgresWorkspace() {
    const sql = library("/sql/telo.yaml", "SQL", {
      resources: [definition("Table", { capability: "Telo.Type", schema: {} })],
    });
    const postgres = library("/pg/telo.yaml", "Postgres", {
      imports: [{ name: "Sql", resolvedPath: "/sql/telo.yaml" }],
      resources: [
        definition("Connection", { capability: "Telo.Provider", schema: {} }),
        definition("Schema", {
          capability: "Telo.Runnable",
          schema: {
            type: "object",
            properties: {
              connection: { "x-telo-ref": "Self.Connection" },
              tables: {
                type: "array",
                items: { "x-telo-ref": { kind: "Sql.Table", use: "dependency" } },
              },
              ledger: { type: "string" },
            },
          },
        }),
      ],
    });
    return consumer([sql, postgres]);
  }

  it("rewrites a declaring module's own alias into the canonical kind", () => {
    const { workspace, manifest } = postgresWorkspace();
    const schema = getAvailableKinds(workspace, manifest).find((k) => k.kindName === "Schema")!
      .schema as Record<string, any>;

    // `Self` is postgres, not the app reading it — carried through raw, this
    // slot resolved to nothing and offered neither candidates nor a create.
    expect(schema.properties.connection["x-telo-ref"]).toBe("Postgres.Connection");
    // The structured form is rewritten through the same accessor, and its
    // siblings survive.
    expect(schema.properties.tables.items["x-telo-ref"]).toEqual({
      kind: "SQL.Table",
      use: "dependency",
    });
  });

  it("leaves a built-in and an unresolvable alias exactly as written", () => {
    const { workspace, manifest } = consumer([
      library("/pg/telo.yaml", "Postgres", {
        resources: [
          definition("Thing", {
            capability: "Telo.Runnable",
            schema: {
              properties: {
                run: { "x-telo-ref": "Telo.Executable" },
                gone: { "x-telo-ref": "Missing.Kind" },
              },
            },
          }),
        ],
      }),
    ]);
    const schema = getAvailableKinds(workspace, manifest)[0].schema as Record<string, any>;

    // A built-in is already canonical; an unresolvable alias keeps the author's
    // own text, so the diagnostic still names what they wrote.
    expect(schema.properties.run["x-telo-ref"]).toBe("Telo.Executable");
    expect(schema.properties.gone["x-telo-ref"]).toBe("Missing.Kind");
  });

  it("returns the same object when nothing needs rewriting", () => {
    const { workspace, manifest } = postgresWorkspace();
    const declaring = workspace.modules.get("/pg/telo.yaml")!;
    const plain = { type: "object", properties: { ledger: { type: "string" } } };

    // Structural sharing: this runs for every kind of every module on every
    // render, and most schema nodes are not ref slots.
    expect(canonicalizeSchemaRefs(workspace, declaring, plain)).toBe(plain);
  });

  it("never mutates the parsed manifest it read from", () => {
    const { workspace, manifest } = postgresWorkspace();
    getAvailableKinds(workspace, manifest);

    const declared = workspace.modules
      .get("/pg/telo.yaml")!
      .resources.find((r) => r.name === "Schema")!.fields.schema as Record<string, any>;
    expect(declared.properties.connection["x-telo-ref"]).toBe("Self.Connection");
  });
});

describe("getImportedConfig", () => {
  it("carries each library's declared variables/secrets under its alias", () => {
    const s3 = library("/ws/s3/telo.yaml", "s3");
    s3.variables = { bucket: { type: "string", description: "Target bucket." } };
    s3.secrets = { accessKey: { type: "string" } };
    const plain = library("/ws/plain/telo.yaml", "plain");

    const { workspace, manifest } = consumer([s3, plain]);
    const config = getImportedConfig(workspace, manifest);

    expect(config.get("S3")).toEqual({
      variables: { bucket: { type: "string", description: "Target bucket." } },
      secrets: { accessKey: { type: "string" } },
    });
    // Read but declaring nothing is still an ANSWER: the entry is present and
    // empty, which is what closes the set of names an importer may write. Only
    // an unreadable library is absent.
    expect(config.get("Plain")).toEqual({});
  });

  it("skips an import the workspace could not resolve", () => {
    const { workspace, manifest } = consumer([]);
    manifest.imports = [
      { name: "Missing", source: "oci://example/x@1", importKind: "oci" },
    ];
    expect(getImportedConfig(workspace, manifest).size).toBe(0);
  });
});
