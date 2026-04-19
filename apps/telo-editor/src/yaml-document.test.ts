import { describe, expect, it } from "vitest";
import {
  addImportDocument,
  addResourceDocument,
  applyEdit,
  diffFields,
  findDocForResource,
  parseModuleDocument,
  removeImportDocument,
  removeResourceDocument,
  serializeModuleDocument,
} from "./yaml-document";

describe("parseModuleDocument", () => {
  it("captures docs, text, and loadedJson for a simple single-doc file", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const modDoc = parseModuleDocument("/ws/app/telo.yaml", text);
    expect(modDoc.filePath).toBe("/ws/app/telo.yaml");
    expect(modDoc.text).toBe(text);
    expect(modDoc.docs).toHaveLength(1);
    expect(modDoc.loadedJson).toEqual([
      { kind: "Telo.Application", metadata: { name: "app" } },
    ]);
    expect(modDoc.parseError).toBeUndefined();
  });

  it("parses multi-document files into separate docs", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "port: 8080",
      "",
    ].join("\n");
    const modDoc = parseModuleDocument("/ws/app/telo.yaml", text);
    expect(modDoc.docs).toHaveLength(2);
    expect(modDoc.loadedJson[0]).toEqual({
      kind: "Telo.Application",
      metadata: { name: "app" },
    });
    expect(modDoc.loadedJson[1]).toEqual({
      kind: "Http.Server",
      metadata: { name: "main" },
      port: 8080,
    });
  });

  it("preserves kind-less documents in the docs array", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "just: some data",
      "",
    ].join("\n");
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    expect(modDoc.docs).toHaveLength(2);
    expect(modDoc.loadedJson[1]).toEqual({ just: "some data" });
  });

  it("flags parse failures via parseError but still exposes the (best-effort) docs", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: [unclosed\n";
    const modDoc = parseModuleDocument("/ws/broken.yaml", text);
    expect(modDoc.parseError).toBeTruthy();
    expect(modDoc.docs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("serializeModuleDocument", () => {
  it("round-trips simple content (comments + multi-doc + kind-less doc)", () => {
    const text = [
      "# top comment",
      "kind: Telo.Application",
      "metadata:",
      "  name: app # inline",
      "---",
      "# comment on kind-less doc",
      "just: data",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "port: 8080",
      "",
    ].join("\n");
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    const out = serializeModuleDocument(modDoc.docs);

    // Semantic content must survive unchanged.
    const reparsed = parseModuleDocument("/ws/telo.yaml", out);
    expect(reparsed.loadedJson).toEqual(modDoc.loadedJson);

    // Comments must survive — string-search rather than byte-compare, since
    // the first serialization is allowed to reformat whitespace/quoting.
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline");
    expect(out).toContain("# comment on kind-less doc");
  });

  it("emits --- separators between every document", () => {
    const text = "kind: A\n---\nkind: B\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    const out = serializeModuleDocument(modDoc.docs);
    // Two `---` markers: one before doc[0], one between docs.
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it("is idempotent across successive serializations when nothing is mutated", () => {
    const text = "kind: Foo\nmetadata:\n  name: a\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    const once = serializeModuleDocument(modDoc.docs);
    const twice = serializeModuleDocument(modDoc.docs);
    expect(twice).toBe(once);
  });
});

describe("applyEdit", () => {
  it("mutates a scalar in place and preserves comments on unrelated nodes", () => {
    const text = [
      "# top comment",
      "kind: Http.Server",
      "metadata:",
      "  name: main # inline",
      "port: 8080",
      "",
    ].join("\n");
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "set", pointer: "/port", value: 9090 });
    const out = serializeModuleDocument(next);
    expect(out).toContain("port: 9090");
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline");
  });

  it("deletes a key via op: delete", () => {
    const text = "kind: Http.Server\nmetadata:\n  name: m\nport: 8080\ntls: true\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "delete", pointer: "/tls" });
    expect(next[0].toJSON()).toEqual({
      kind: "Http.Server",
      metadata: { name: "m" },
      port: 8080,
    });
  });

  it("renames a key via op: rename", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nold: value\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "rename", pointer: "/old", newKey: "new" });
    expect(next[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      new: "value",
    });
  });

  it("appends to an array via op: insert with `-` trailing segment", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nitems:\n  - a\n  - b\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "insert", pointer: "/items/-", value: "c" });
    expect(next[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      items: ["a", "b", "c"],
    });
  });

  it("returns a fresh outer array reference for React ref equality", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nport: 1\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "set", pointer: "/port", value: 2 });
    expect(next).not.toBe(docs);
    expect(next[0]).toBe(docs[0]); // same doc object — in-place mutation
  });
});

describe("diffFields", () => {
  it("emits a single set for a leaf change", () => {
    const ops = diffFields({ a: 1 }, { a: 2 }, "");
    expect(ops).toEqual([{ op: "set", pointer: "/a", value: 2 }]);
  });

  it("emits delete only when the new value is undefined", () => {
    const old = { a: 1, b: 2, c: 3 };
    const neu = { a: 1 } as Record<string, unknown>;
    const ops = diffFields(old, neu, "");
    // b and c are undefined in new → both deleted
    const sorted = [...ops].sort((x, y) => x.pointer.localeCompare(y.pointer));
    expect(sorted).toEqual([
      { op: "delete", pointer: "/b" },
      { op: "delete", pointer: "/c" },
    ]);
  });

  it("treats null as `set null`, NOT as delete", () => {
    const ops = diffFields({ a: 1 }, { a: null }, "");
    expect(ops).toEqual([{ op: "set", pointer: "/a", value: null }]);
  });

  it("treats empty string as `set \"\"`, NOT as delete", () => {
    const ops = diffFields({ a: "hello" }, { a: "" }, "");
    expect(ops).toEqual([{ op: "set", pointer: "/a", value: "" }]);
  });

  it("emits ops in descending-index order for array trailing deletes", () => {
    const ops = diffFields({ xs: [1, 2, 3, 4] }, { xs: [1, 2] }, "");
    // Expected: [delete /xs/3, delete /xs/2] (descending)
    expect(ops).toEqual([
      { op: "delete", pointer: "/xs/3" },
      { op: "delete", pointer: "/xs/2" },
    ]);
  });

  it("emits set ops before delete ops within one array diff", () => {
    // old [a, b, c] → new [a, x]: positional index 1 changes, index 2 removed.
    const ops = diffFields({ xs: ["a", "b", "c"] }, { xs: ["a", "x"] }, "");
    const setIdx = ops.findIndex((o) => o.op === "set");
    const delIdx = ops.findIndex((o) => o.op === "delete");
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeLessThan(delIdx);
  });

  it("recurses into nested objects and emits per-leaf ops", () => {
    const ops = diffFields(
      { config: { port: 8080, host: "a" } },
      { config: { port: 9090, host: "a" } },
      "",
    );
    expect(ops).toEqual([{ op: "set", pointer: "/config/port", value: 9090 }]);
  });

  it("escapes `/` and `~` in JSON pointer segments", () => {
    const ops = diffFields({ "a/b": 1 }, { "a/b": 2 }, "");
    expect(ops[0].pointer).toBe("/a~1b");
  });

  it("applied sequentially, ops produce the expected new state", () => {
    // Simulates the realistic "handleUpdateResource" flow.
    const old = { xs: [10, 20, 30], y: "hi" };
    const neu = { xs: [10, 40], y: "bye" };
    const ops = diffFields(old, neu, "");

    // Apply ops to a YAML doc and verify toJSON matches neu.
    const text = "kind: Foo\nmetadata:\n  name: m\nxs:\n  - 10\n  - 20\n  - 30\ny: hi\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    let current = docs;
    for (const op of ops) current = applyEdit(current, 0, op);

    expect(current[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      ...neu,
    });
  });
});

describe("document-level helpers", () => {
  it("addResourceDocument appends to the end of docs", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addResourceDocument(docs, "Http.Server", "main", { port: 8080 });
    expect(next).toHaveLength(2);
    expect(next[1].toJSON()).toEqual({
      kind: "Http.Server",
      metadata: { name: "main" },
      port: 8080,
    });
  });

  it("removeResourceDocument removes the matching doc", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "",
    ].join("\n");
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = removeResourceDocument(docs, "Http.Server", "main");
    expect(next).toHaveLength(1);
    expect(next[0].toJSON()).toMatchObject({ kind: "Telo.Application" });
  });

  it("addImportDocument inserts after the module doc when no imports exist", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addImportDocument(docs, "Lib", "../lib");
    expect(next).toHaveLength(2);
    expect(next[0].toJSON()).toMatchObject({ kind: "Telo.Application" });
    expect(next[1].toJSON()).toEqual({
      kind: "Telo.Import",
      metadata: { name: "Lib" },
      source: "../lib",
    });
  });

  it("addImportDocument inserts after the last existing import", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Telo.Import",
      "metadata:",
      "  name: A",
      "source: ../a",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "",
    ].join("\n");
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addImportDocument(docs, "B", "../b");
    // Module, Import A, NEW Import B, Http.Server
    expect(next).toHaveLength(4);
    expect((next[2].toJSON() as Record<string, unknown>).metadata).toMatchObject({ name: "B" });
    expect((next[3].toJSON() as Record<string, unknown>).kind).toBe("Http.Server");
  });

  it("removeImportDocument removes the matching import", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Telo.Import",
      "metadata:",
      "  name: Lib",
      "source: ../lib",
      "",
    ].join("\n");
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    const next = removeImportDocument(docs, "Lib");
    expect(next).toHaveLength(1);
  });
});

describe("findDocForResource", () => {
  it("returns the index of the matching doc", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: other",
      "",
    ].join("\n");
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "main")).toBe(1);
    expect(findDocForResource(docs, "Http.Server", "other")).toBe(2);
    expect(findDocForResource(docs, "Telo.Application", "app")).toBe(0);
  });

  it("returns undefined when no doc matches", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "missing")).toBeUndefined();
  });

  it("skips kind-less docs without matching them", () => {
    const text = "just: data\n---\nkind: Http.Server\nmetadata:\n  name: main\n";
    const { docs } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "main")).toBe(1);
  });
});
