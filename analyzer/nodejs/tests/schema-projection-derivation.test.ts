import { describe, expect, it } from "vitest";
import { libraryDeclarations } from "../src/library-declarations.js";
import {
  manifestListScope,
  resolveSchemaProjections,
  type ProjectionFailure,
  type ProjectionModules,
} from "../src/schema-projection.js";

/**
 * A projection pointer crossing references: the holder kind's field map decides
 * where a reference is, and a hop into a library's internals resolves in that
 * library's own documents.
 */
const shapeDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Shape", module: "kinds" },
  "x-telo-schema-projection": { entries: "/fields", key: "type" },
  schema: {
    type: "object",
    properties: {
      fields: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            type: {
              type: "string",
              "x-telo-schema-map": { text: { type: "string" }, number: { type: "number" } },
            },
          },
        },
      },
    },
  },
};

const nodeDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Node", module: "kinds" },
  "x-telo-schema-projection-from": "/shape",
  schema: { type: "object" },
};

const definitions: Record<string, Record<string, any>> = {
  "kinds.Shape": shapeDefinition,
  "kinds.Node": nodeDefinition,
};

/** Reference slots by kind, as the field map would list them. */
const slots: Record<string, string[]> = {
  "kinds.Shape": [],
  "kinds.Node": ["shape"],
  "app.Write": ["node", "type"],
};

function modules(overrides: Partial<ProjectionModules> = {}): ProjectionModules {
  return {
    moduleForAlias: () => undefined,
    referenceSlots: (declaration) => slots[declaration.kind as string],
    ...overrides,
  };
}

const project = (
  slot: Record<string, unknown>,
  consumer: Record<string, any>,
  manifests: Record<string, any>[],
  projectionModules: ProjectionModules,
) => {
  const failures: ProjectionFailure[] = [];
  const scope = manifestListScope(manifests, (kind) => definitions[kind], projectionModules);
  return { resolved: resolveSchemaProjections(slot, consumer, scope, failures), failures };
};

const users = {
  kind: "kinds.Shape",
  metadata: { name: "users", module: "App" },
  fields: { email: { type: "text" } },
};

describe("where a projection pointer finds a reference", () => {
  it("walks a field its kind does not declare as a reference as data, even shaped { kind, name }", () => {
    const consumer = {
      kind: "app.Write",
      metadata: { name: "write", module: "App" },
      meta: { kind: "kinds.Shape", name: "users" },
    };
    const slot = { "x-telo-schema-projection-from": "/meta" };
    const { resolved, failures } = project(slot, consumer, [users, consumer], modules());
    expect(resolved).toBe(slot);
    expect(failures).toEqual([{ reason: "no-ref", pointer: "/meta" }]);
  });

  it("walks a value a union value/reference slot holds as data", () => {
    const consumer = { kind: "app.Write", metadata: { name: "write", module: "App" }, type: "text" };
    const slot = { "x-telo-schema-projection-from": "/type" };
    const { failures } = project(slot, consumer, [users, consumer], modules());
    expect(failures).toEqual([{ reason: "no-ref", pointer: "/type" }]);
  });

  it("continues into an inline declaration at a reference slot, through its kind's derivation", () => {
    const consumer = {
      kind: "app.Write",
      metadata: { name: "write", module: "App" },
      node: { kind: "kinds.Node", shape: { kind: "kinds.Shape", name: "users" } },
    };
    const { resolved, failures } = project(
      { "x-telo-schema-projection-from": "/node" },
      consumer,
      [users, consumer],
      modules(),
    );
    expect(failures).toEqual([]);
    expect(resolved).toEqual({
      type: "object",
      properties: { email: { type: "string" } },
      additionalProperties: false,
    });
  });
});

describe("a projection hop into a library's internals", () => {
  const library = (module: string, fields: Record<string, unknown>) => ({
    module,
    sourceId: module,
    exportedNames: ["person"],
    manifests: [
      { kind: "Telo.Library", metadata: { name: module } },
      {
        kind: "kinds.Node",
        metadata: { name: "person", module },
        shape: { __tagged: true, engine: "ref", source: "users" },
      },
      { kind: "kinds.Shape", metadata: { name: "users", module }, fields },
    ],
  });
  const libA = library("LibA", { handle: { type: "text" } });
  const libB = library("LibB", { id: { type: "number" } });
  /** What the flattened set carries: each library's exported `person` only. */
  const forwarded = [libA, libB].map((lib) => ({
    ...lib.manifests[1],
    metadata: { name: "person", module: lib.module, forwardedExport: true },
  }));

  it("types each library's export against that library's own internal declaration, closed", () => {
    const writes = ["LibA", "LibB"].map((alias) => ({
      kind: "app.Write",
      metadata: { name: `write${alias}`, module: "App" },
      node: { kind: "kinds.Node", name: "person", alias },
    }));
    const projectionModules = modules({
      moduleForAlias: (module, alias) => (module === "App" ? alias : undefined),
      libraries: libraryDeclarations([libA, libB]),
    });
    const [a, b] = writes.map((write) =>
      project(
        { "x-telo-schema-projection-from": "/node" },
        write,
        [...forwarded, ...writes],
        projectionModules,
      ),
    );
    expect(a!.failures).toEqual([]);
    expect(b!.failures).toEqual([]);
    expect(a!.resolved).toEqual({
      type: "object",
      properties: { handle: { type: "string" } },
      additionalProperties: false,
    });
    expect(b!.resolved).toEqual({
      type: "object",
      properties: { id: { type: "number" } },
      additionalProperties: false,
    });
  });
});

describe("a reference resolves only in its holder's scope", () => {
  const ref = (source: string) => ({ __tagged: true, engine: "ref", source });
  const slot = { "x-telo-schema-projection-from": "/node" };
  const write = (node: Record<string, unknown>) => ({
    kind: "app.Write",
    metadata: { name: "write", module: "App" },
    node,
  });
  const appUsers = { ...users, metadata: { name: "users", module: "App" } };

  it("does not reach the application's resource from a library's declaration", () => {
    const person = {
      kind: "kinds.Node",
      metadata: { name: "person", module: "LibA", forwardedExport: true },
      shape: ref("users"),
    };
    const consumer = write({ kind: "kinds.Node", name: "person", alias: "LibA" });
    const { failures } = project(
      slot,
      consumer,
      [appUsers, person, consumer],
      modules({ moduleForAlias: (module, alias) => (module === "App" ? alias : undefined) }),
    );
    expect(failures).toEqual([
      { reason: "unresolved", pointer: "/node", name: "users", via: { prefix: "/shape", holder: "person" } },
    ]);
  });

  it("does not reach another module's resource from a root holder", () => {
    const libUsers = { ...users, metadata: { name: "users", module: "LibA", forwardedExport: true } };
    const consumer = {
      kind: "kinds.Node",
      metadata: { name: "person", module: "App" },
      shape: ref("users"),
    };
    const { failures } = project(
      { "x-telo-schema-projection-from": "/shape" },
      consumer,
      [libUsers, consumer],
      modules(),
    );
    expect(failures).toEqual([{ reason: "unresolved", pointer: "/shape", name: "users" }]);
  });

  it("does not resolve through an alias the holder's module does not import", () => {
    const person = { kind: "kinds.Node", metadata: { name: "person", module: "App" }, shape: ref("users") };
    const consumer = write({ kind: "kinds.Node", name: "person", alias: "Missing" });
    const { failures } = project(slot, consumer, [appUsers, person, consumer], modules());
    expect(failures).toEqual([{ reason: "unresolved", pointer: "/node", name: "person" }]);
  });

  it("resolves by name across a set carrying no module stamps", () => {
    const bare = { kind: "kinds.Shape", metadata: { name: "users" }, fields: { id: { type: "number" } } };
    const consumer = {
      kind: "kinds.Node",
      metadata: { name: "person" },
      shape: ref("users"),
    };
    const { resolved, failures } = project(
      { "x-telo-schema-projection-from": "/shape" },
      consumer,
      [bare, consumer],
      modules(),
    );
    expect(failures).toEqual([]);
    expect(resolved).toEqual({
      type: "object",
      properties: { id: { type: "number" } },
      additionalProperties: false,
    });
  });
});
