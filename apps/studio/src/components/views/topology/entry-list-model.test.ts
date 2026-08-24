import { Loader, type ManifestSource } from "@telorun/analyzer";
import { makeTaggedSentinel } from "@telorun/templating";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEntryList, entryListOf } from "./entry-list-model";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const diskSource: ManifestSource = {
  supports: () => true,
  read: async (url) => ({ text: await readFile(url, "utf8"), source: url }),
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/**
 * Read against the REAL `Http.Server` schema. What this model relies on is an
 * annotation on a shipped manifest and a ref slot the analyzer recognises — a
 * hand-written schema would assert that the editor agrees with itself.
 */
describe("entry list model", () => {
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    const loaded = await new Loader([diskSource]).loadModule(
      `${repoRoot}/modules/http-server/telo.yaml`,
    );
    const server = loaded.owner.manifests.find(
      (m) => m?.kind === "Telo.Definition" && (m.metadata as { name?: string })?.name === "Server",
    ) as Record<string, unknown> | undefined;
    expect(server, "Http.Server definition").toBeDefined();
    schema = server!.schema as Record<string, unknown>;
  });

  const ref = (name: string) => makeTaggedSentinel("ref", name);

  it("reads the whole grammar off the annotations", () => {
    // `entries` on the array, `matcher` on the field that selects one,
    // `handler` on the reference it dispatches to — the same three tokens
    // `Http.Api.routes` and `Mcp.Tools.entries` carry.
    expect(entryListOf(schema)).toMatchObject({
      name: "mounts",
      handler: "mount",
      matcher: "path",
    });
    expect(entryListOf(schema)!.itemSchema.title).toBe("Mount");
  });

  it("falls back to a ref slot for items published before the handler role", () => {
    // Two spellings, one answer — the `x-telo-step-context` precedent. Without
    // it every already-published entry list would stop rendering.
    const legacy = {
      properties: {
        list: {
          "x-telo-topology-role": "entries",
          type: "array",
          items: {
            type: "object",
            properties: { target: { "x-telo-ref": { kind: "Telo.Mount", use: "dependency" } } },
          },
        },
      },
    };
    expect(entryListOf(legacy)).toMatchObject({ name: "list", handler: "target" });
  });

  it("claims nothing when the entries have no handler to dispatch to", () => {
    // A list of entries dispatching to nothing is not this view's shape, and
    // rendering it would be a column of rows all saying "(nothing attached)".
    // The kind falls through to the ordinary field form instead.
    const configOnly = {
      properties: {
        catches: {
          "x-telo-topology-role": "entries",
          type: "array",
          items: { type: "object", properties: { when: { type: "boolean" }, value: {} } },
        },
      },
    };
    expect(entryListOf(configOnly)).toBeNull();
  });

  it("reads each entry as a row with the pointer an edit needs", () => {
    const rows = buildEntryList({
      entries: [
        { path: "/v1", mount: ref("usersApi") },
        { mount: ref("docs"), logging: { level: "warn" } },
      ],
      list: entryListOf(schema)!,
      pointer: "/mounts",
      declared: new Set(["usersApi", "docs"]),
    });

    expect(rows[0]).toMatchObject({
      pointer: "/mounts/0",
      index: 0,
      target: "usersApi",
      unresolved: false,
    });
    // The matcher is separated out, because it is what tells one entry from the
    // next — two mounts of the same API differ only here.
    expect(rows[0]!.matcher).toMatchObject({ name: "path", value: "/v1" });
    expect(rows[1]!.matcher).toBeUndefined();
    // The rest is declaration order, and only what the author set — an entry
    // listing every optional field as unset would bury the one or two that say
    // what it does. Neither handler nor matcher repeats here.
    expect(rows[0]!.fields.map((f) => f.name)).toEqual([]);
    expect(rows[1]!.fields.map((f) => f.name)).toEqual(["logging"]);
  });

  it("reports an entry attaching a resource the module does not declare", () => {
    const [row] = buildEntryList({
      entries: [{ mount: ref("missing") }],
      list: entryListOf(schema)!,
      pointer: "/mounts",
      declared: new Set(),
    });
    expect(row).toMatchObject({ target: "missing", unresolved: true });
  });

  it("keeps an entry attaching nothing as a row rather than dropping it", () => {
    // It is in the manifest, and an empty mount is exactly what "Add mount"
    // leaves behind until the reference is filled in.
    const [row] = buildEntryList({
      entries: [{}],
      list: entryListOf(schema)!,
      pointer: "/mounts",
      declared: new Set(),
    });
    expect(row).toMatchObject({ pointer: "/mounts/0", unresolved: false });
    expect(row!.target).toBeUndefined();
  });

  it("claims nothing for a kind with no entry list", () => {
    expect(entryListOf({ properties: { port: { type: "integer" } } })).toBeNull();
    expect(entryListOf({ type: "object" })).toBeNull();
  });
});
