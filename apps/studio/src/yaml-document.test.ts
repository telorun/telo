import { describe, expect, it } from "vitest";
import {
  addImportDocument,
  addInlineImport,
  addResourceDocument,
  applyEdit,
  diffFields,
  expandInlineImportShorthand,
  findDocForResource,
  moduleParseError,
  parseModuleDocument,
  removeImportDocument,
  removeResourceDocument,
  serializeModuleDocument,
  setInlineImportSource,
} from "./yaml-document";

describe("parseModuleDocument with templating tags", () => {
  it("resolves a !cel-tagged scalar to a sentinel object in loadedJson", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nexpr: !cel 'variables.port'\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    expect(moduleParseError(modDoc)).toBeUndefined();
    expect(modDoc.loaded.manifests[0]).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      expr: { __tagged: true, engine: "cel", source: "variables.port" },
    });
  });

  it("resolves a !literal-tagged scalar to a sentinel that preserves ${{ }} verbatim", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nexpr: !literal 'Hello ${{ x }}'\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    expect(modDoc.loaded.manifests[0]).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      expr: { __tagged: true, engine: "literal", source: "Hello ${{ x }}" },
    });
  });

  it("round-trips !cel and !literal tags through serialize → parse", () => {
    const text =
      "kind: Foo\nmetadata:\n  name: m\ncel: !cel 'variables.port'\nlit: !literal 'Hello ${{ x }}'\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const out = serializeModuleDocument(docs);
    expect(out).toContain("!cel");
    expect(out).toContain("variables.port");
    expect(out).toContain("!literal");
    expect(out).toContain("Hello ${{ x }}");
    // Re-parse the serialized output and confirm the sentinels survive.
    const reparsed = parseModuleDocument("/ws/telo.yaml", out);
    expect(moduleParseError(reparsed)).toBeUndefined();
    expect((reparsed.loaded.manifests[0] as Record<string, unknown>).cel).toEqual({
      __tagged: true,
      engine: "cel",
      source: "variables.port",
    });
    expect((reparsed.loaded.manifests[0] as Record<string, unknown>).lit).toEqual({
      __tagged: true,
      engine: "literal",
      source: "Hello ${{ x }}",
    });
  });
});

describe("parseModuleDocument", () => {
  it("captures docs, text, and loadedJson for a simple single-doc file", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const modDoc = parseModuleDocument("/ws/app/telo.yaml", text);
    expect(modDoc.filePath).toBe("/ws/app/telo.yaml");
    expect(modDoc.loaded.text).toBe(text);
    expect(modDoc.loaded.documents).toHaveLength(1);
    expect(modDoc.loaded.manifests).toEqual([
      { kind: "Telo.Application", metadata: { name: "app" } },
    ]);
    expect(moduleParseError(modDoc)).toBeUndefined();
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
    expect(modDoc.loaded.documents).toHaveLength(2);
    expect(modDoc.loaded.manifests[0]).toEqual({
      kind: "Telo.Application",
      metadata: { name: "app" },
    });
    expect(modDoc.loaded.manifests[1]).toEqual({
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
    expect(modDoc.loaded.documents).toHaveLength(2);
    expect(modDoc.loaded.manifests[1]).toEqual({ just: "some data" });
  });

  it("flags parse failures via parseError but still exposes the (best-effort) docs", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: [unclosed\n";
    const modDoc = parseModuleDocument("/ws/broken.yaml", text);
    expect(moduleParseError(modDoc)).toBeTruthy();
    expect(modDoc.loaded.documents.length).toBeGreaterThanOrEqual(1);
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
    const out = serializeModuleDocument(modDoc.loaded.documents);

    // Semantic content must survive unchanged.
    const reparsed = parseModuleDocument("/ws/telo.yaml", out);
    expect(reparsed.loaded.manifests).toEqual(modDoc.loaded.manifests);

    // Comments must survive — string-search rather than byte-compare, since
    // the first serialization is allowed to reformat whitespace/quoting.
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline");
    expect(out).toContain("# comment on kind-less doc");
  });

  it("emits --- separators between every document", () => {
    const text = "kind: A\n---\nkind: B\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    const out = serializeModuleDocument(modDoc.loaded.documents);
    // Two `---` markers: one before doc[0], one between docs.
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it("is idempotent across successive serializations when nothing is mutated", () => {
    const text = "kind: Foo\nmetadata:\n  name: a\n";
    const modDoc = parseModuleDocument("/ws/telo.yaml", text);
    const once = serializeModuleDocument(modDoc.loaded.documents);
    const twice = serializeModuleDocument(modDoc.loaded.documents);
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "set", pointer: "/port", value: 9090 });
    const out = serializeModuleDocument(next);
    expect(out).toContain("port: 9090");
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline");
  });

  it("renames a key in place, keeping its position, its value and its comments", () => {
    // The whole point of `rename` being its own op: expressed as a field diff a
    // rename reads as delete-plus-add, and `setIn` on an absent key APPENDS —
    // so the entry would move to the end of the block and its value would be
    // re-serialized from plain data, losing comments and quote style.
    const text = [
      "kind: Telo.Application",
      "variables:",
      "  # what the database is",
      '  dbConnection: { env: "DB_CONNECTION", type: string }',
      "  trackLoop:",
      "    env: TRACK_LOOP",
      "    type: boolean",
      "ports:",
      "  http:",
      "    env: PORT",
      "",
    ].join("\n");
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, {
      op: "rename",
      pointer: "/variables/dbConnection",
      newKey: "database",
    });
    const out = serializeModuleDocument(next);

    expect(Object.keys((next[0].toJSON() as { variables: object }).variables)).toEqual([
      "database",
      "trackLoop",
    ]);
    expect(out).toContain("# what the database is");
    expect(out).toContain('database: { env: "DB_CONNECTION", type: string }');
    // Nothing outside the renamed key moved.
    expect(out).toContain("ports:");
  });

  it("leaves a rename alone when the key is not there", () => {
    const text = "kind: Telo.Application\nvariables:\n  a:\n    env: A\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "rename", pointer: "/variables/gone", newKey: "b" });
    // Refused rather than writing a second entry — the ordinary validators then
    // report the manifest as it actually is.
    expect(next[0].toJSON()).toEqual({ kind: "Telo.Application", variables: { a: { env: "A" } } });
  });

  it("deletes a key via op: delete", () => {
    const text = "kind: Http.Server\nmetadata:\n  name: m\nport: 8080\ntls: true\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "delete", pointer: "/tls" });
    expect(next[0].toJSON()).toEqual({
      kind: "Http.Server",
      metadata: { name: "m" },
      port: 8080,
    });
  });

  it("renames a key via op: rename", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nold: value\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "rename", pointer: "/old", newKey: "new" });
    expect(next[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      new: "value",
    });
  });

  it("appends to an array via op: insert with `-` trailing segment", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nitems:\n  - a\n  - b\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "insert", pointer: "/items/-", value: "c" });
    expect(next[0].toJSON()).toEqual({
      kind: "Foo",
      metadata: { name: "m" },
      items: ["a", "b", "c"],
    });
  });

  it("returns a fresh outer array reference for React ref equality", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nport: 1\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "set", pointer: "/port", value: 2 });
    expect(next).not.toBe(docs);
    expect(next[0]).toBe(docs[0]); // same doc object — in-place mutation
  });

  it("setTag attaches a YAML tag to a scalar that round-trips on serialize", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nexpr: variables.port\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "setTag", pointer: "/expr", tag: "!cel" });
    const out = serializeModuleDocument(next);
    expect(out).toContain("!cel");
    expect(out).toContain("variables.port");
  });

  it("setTag with null clears an existing tag", () => {
    const text = "kind: Foo\nmetadata:\n  name: m\nexpr: !cel variables.port\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "setTag", pointer: "/expr", tag: null });
    const out = serializeModuleDocument(next);
    expect(out).not.toContain("!cel");
  });

  it("set preserves an existing tag when the JS type changes", () => {
    // The in-place path keeps tags naturally; this test exercises the
    // structural-replace path by changing a number to a string.
    const text = "kind: Foo\nmetadata:\n  name: m\nexpr: !cel 42\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = applyEdit(docs, 0, { op: "set", pointer: "/expr", value: "variables.port" });
    const out = serializeModuleDocument(next);
    expect(out).toContain("!cel");
    expect(out).toContain("variables.port");
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = removeResourceDocument(docs, "Http.Server", "main");
    expect(next).toHaveLength(1);
    expect(next[0].toJSON()).toMatchObject({ kind: "Telo.Application" });
  });

  it("addImportDocument inserts after the module doc when no imports exist", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addImportDocument(docs, "B", "../b");
    // Module, Import A, NEW Import B, Http.Server
    expect(next).toHaveLength(4);
    expect((next[2].toJSON() as Record<string, unknown>).metadata).toMatchObject({ name: "B" });
    expect((next[3].toJSON() as Record<string, unknown>).kind).toBe("Http.Server");
  });

  it("addInlineImport writes into the module doc's imports map, no new doc", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addInlineImport(docs, "Lib", "../lib");
    expect(next).toHaveLength(1);
    expect(next[0].toJSON()).toEqual({
      kind: "Telo.Application",
      metadata: { name: "app" },
      imports: { Lib: "../lib" },
    });
  });

  it("addInlineImport uses the object form when variables/secrets are given", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const next = addInlineImport(docs, "Lib", "../lib", { variables: { port: 8080 } });
    expect((next[0].toJSON() as Record<string, unknown>).imports).toEqual({
      Lib: { source: "../lib", variables: { port: 8080 } },
    });
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
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
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "main")).toBe(1);
    expect(findDocForResource(docs, "Http.Server", "other")).toBe(2);
    expect(findDocForResource(docs, "Telo.Application", "app")).toBe(0);
  });

  it("returns undefined when no doc matches", () => {
    const text = "kind: Telo.Application\nmetadata:\n  name: app\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "missing")).toBeUndefined();
  });

  it("skips kind-less docs without matching them", () => {
    const text = "just: data\n---\nkind: Http.Server\nmetadata:\n  name: main\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    expect(findDocForResource(docs, "Http.Server", "main")).toBe(1);
  });
});

describe("addInlineImport duplicate-alias guard", () => {
  const base = "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Console: std/console@0.9.0\n";

  it("adds a new alias", () => {
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", base);
    const out = addInlineImport(docs, "Http", "std/http-server@0.19.1");
    const yaml = serializeModuleDocument(out);
    expect(yaml).toContain("Http: std/http-server@0.19.1");
    expect(yaml).toContain("Console: std/console@0.9.0");
  });

  it("throws instead of clobbering an existing alias", () => {
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", base);
    expect(() => addInlineImport(docs, "Console", "std/other@1.0.0")).toThrow(
      /alias "Console" already exists.*std\/console@0\.9\.0/,
    );
  });
});

describe("setInlineImportSource", () => {
  it("re-points a scalar OCI import in place", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Timer: oci://ghcr.io/telorun/timer@0.3.0#sha256-abc\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const out = setInlineImportSource(docs, "Timer", "oci://ghcr.io/telorun/timer@0.4.0");
    expect(serializeModuleDocument(out)).toContain("Timer: oci://ghcr.io/telorun/timer@0.4.0");
  });

  it("carries a new pin into a scalar import as a fragment", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Timer: oci://ghcr.io/telorun/timer@0.3.0#sha256-abc\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const out = setInlineImportSource(docs, "Timer", "oci://ghcr.io/telorun/timer@0.4.0#sha256-def");
    expect(serializeModuleDocument(out)).toContain(
      "Timer: oci://ghcr.io/telorun/timer@0.4.0#sha256-def",
    );
  });

  it("drops a stale integrity sibling from the object form", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Timer:\n    source: oci://ghcr.io/telorun/timer@0.3.0\n    integrity: sha256-abc\n    variables:\n      tz: UTC\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const yaml = serializeModuleDocument(
      setInlineImportSource(docs, "Timer", "oci://ghcr.io/telorun/timer@0.4.0"),
    );
    expect(yaml).toContain("source: oci://ghcr.io/telorun/timer@0.4.0");
    expect(yaml).not.toContain("integrity");
    expect(yaml).toContain("tz: UTC");
  });

  it("re-pins the object form in place, keeping the sibling shape", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Timer:\n    source: oci://ghcr.io/telorun/timer@0.3.0\n    integrity: sha256-abc\n    variables:\n      tz: UTC\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const yaml = serializeModuleDocument(
      setInlineImportSource(docs, "Timer", "oci://ghcr.io/telorun/timer@0.4.0#sha256-def"),
    );
    expect(yaml).toContain("source: oci://ghcr.io/telorun/timer@0.4.0");
    expect(yaml).toContain("integrity: sha256-def");
    expect(yaml).not.toContain("#sha256-def");
    expect(yaml).toContain("tz: UTC");
  });

  it("pins an object-form entry that had no sibling via the source fragment", () => {
    const text =
      "kind: Telo.Application\nmetadata:\n  name: app\nimports:\n  Timer:\n    source: oci://ghcr.io/telorun/timer@0.3.0\n    variables:\n      tz: UTC\n";
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    const yaml = serializeModuleDocument(
      setInlineImportSource(docs, "Timer", "oci://ghcr.io/telorun/timer@0.4.0#sha256-def"),
    );
    expect(yaml).toContain("source: oci://ghcr.io/telorun/timer@0.4.0#sha256-def");
    expect(yaml).not.toContain("integrity:");
  });
});

describe("expandInlineImportShorthand", () => {
  const shorthand = [
    "kind: Telo.Application",
    "metadata:",
    "  name: app",
    "imports:",
    "  Console: oci://ghcr.io/telorun/console@0.9.0 # pinned",
    "  Http: ../http-server",
    "",
  ].join("\n");

  it("widens only the named alias, keeping the value's comment", () => {
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", shorthand);
    const next = expandInlineImportShorthand(docs, ["Console"]);
    const text = serializeModuleDocument(next);
    expect(text).toContain("source: oci://ghcr.io/telorun/console@0.9.0 # pinned");
    // Untouched aliases keep the shape their author chose.
    expect(text).toContain("Http: ../http-server");
  });

  it("lets a nested write land on what was a shorthand entry", () => {
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", shorthand);
    // The write the detail panel produces when a value is added to an import.
    const op = { op: "set", pointer: "/imports/Console/variables", value: { level: "debug" } } as const;
    expect(() => applyEdit(docs, 0, op)).toThrow(/Expected YAML collection/);

    const widened = expandInlineImportShorthand(docs, ["Console"]);
    const written = applyEdit(widened, 0, op);
    expect((written[0].toJSON() as { imports: Record<string, unknown> }).imports.Console).toEqual({
      source: "oci://ghcr.io/telorun/console@0.9.0",
      variables: { level: "debug" },
    });
  });

  it("is a no-op on an object-form entry and on an unknown alias", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "imports:",
      "  Console:",
      "    source: ../console",
      "",
    ].join("\n");
    const { loaded: { documents: docs } } = parseModuleDocument("/ws/telo.yaml", text);
    expect(expandInlineImportShorthand(docs, ["Console", "Nope"])).toBe(docs);
  });
});

describe("applyEdit move", () => {
  const app = [
    "kind: Telo.Application",
    "metadata:",
    "  name: app",
    "targets:",
    "  # the boot sequence",
    "  - !ref db",
    "  # the server needs the database up",
    "  - !ref server # trailing",
    "  - !ref worker",
    "",
  ].join("\n");

  function docsOf(text: string) {
    return parseModuleDocument("/ws/telo.yaml", text).loaded.documents;
  }

  function order(docs: ReturnType<typeof docsOf>): string[] {
    return serializeModuleDocument(docs).match(/!ref \w+/g) ?? [];
  }

  it("carries an entry's tag and its own comments to the new position", () => {
    const next = applyEdit(docsOf(app), 0, { op: "move", pointer: "/targets/1", toIndex: 2 });
    const text = serializeModuleDocument(next);
    expect(order(next)).toEqual(["!ref db", "!ref worker", "!ref server"]);
    // Both comments attached to the entry travel with it, and the `!ref` tag
    // survives — none of which a value-level rewrite would preserve.
    expect(text).toMatch(/# the server needs the database up\n\s*- !ref server # trailing/);
    // A comment on the block's FIRST line belongs to the block, not to the entry
    // that happened to follow it, so it stays put as the list's header.
    expect(text.indexOf("# the boot sequence")).toBeLessThan(text.indexOf("!ref db"));
  });

  it("moves backwards too", () => {
    const next = applyEdit(docsOf(app), 0, { op: "move", pointer: "/targets/2", toIndex: 0 });
    expect(order(next)).toEqual(["!ref worker", "!ref db", "!ref server"]);
  });

  it("clamps a drop past the end rather than refusing it", () => {
    const next = applyEdit(docsOf(app), 0, { op: "move", pointer: "/targets/0", toIndex: 99 });
    expect(order(next)).toEqual(["!ref server", "!ref worker", "!ref db"]);
  });

  it("leaves the document alone when the target is not a sequence item", () => {
    const before = serializeModuleDocument(docsOf(app));
    const missing = applyEdit(docsOf(app), 0, { op: "move", pointer: "/targets/9", toIndex: 0 });
    expect(serializeModuleDocument(missing)).toBe(before);
    const notASeq = applyEdit(docsOf(app), 0, { op: "move", pointer: "/metadata/0", toIndex: 1 });
    expect(serializeModuleDocument(notASeq)).toBe(before);
  });

  it("refuses a pointer that names a key rather than an index", () => {
    expect(() => applyEdit(docsOf(app), 0, { op: "move", pointer: "/targets", toIndex: 0 })).toThrow(
      /sequence index/,
    );
  });
});

describe("applyEdit rename", () => {
  const app = [
    "kind: Telo.Application",
    "metadata:",
    "  name: app",
    "variables:",
    "  first:",
    "    env: FIRST",
    "  second:",
    "    env: SECOND",
    "",
  ].join("\n");

  function docsOf(text: string) {
    return parseModuleDocument("/ws/telo.yaml", text).loaded.documents;
  }

  it("renames a key in place, keeping its position and its value node", () => {
    const next = applyEdit(docsOf(app), 0, {
      op: "rename",
      pointer: "/variables/first",
      newKey: "renamed",
    });
    const text = serializeModuleDocument(next);
    expect(text).toMatch(/renamed:\s*\n\s*env: FIRST/);
    expect(text.indexOf("renamed")).toBeLessThan(text.indexOf("second"));
  });

  it("refuses a rename onto a key the mapping already has", () => {
    // In-place key mutation cannot overwrite the way delete-then-set did, so
    // without this the mapping ends up with two `second:` entries — a document
    // no reader agrees about. The form's own check is UX; this is the operation
    // refusing to produce an invalid document.
    expect(() =>
      applyEdit(docsOf(app), 0, {
        op: "rename",
        pointer: "/variables/first",
        newKey: "second",
      }),
    ).toThrow(/already exists/);
  });

  it("allows a rename to the name it already has", () => {
    expect(() =>
      applyEdit(docsOf(app), 0, { op: "rename", pointer: "/variables/first", newKey: "first" }),
    ).not.toThrow();
  });
});

describe("applyEdit relocate", () => {
  // A step body: the shape a relocate exists for, since a `move` cannot leave
  // the sequence it started in.
  const sequence = [
    "kind: Run.Sequence",
    "metadata:",
    "  name: flow",
    "steps:",
    "  - name: first",
    "    invoke: !ref alpha",
    "  - name: branch",
    "    if: !cel ok",
    "    then:",
    "      # only when ok",
    "      - name: inner",
    "        invoke: !ref beta # trailing",
    "    else:",
    "      - name: other",
    "        invoke: !ref gamma",
    "",
  ].join("\n");

  function docsOf(text: string) {
    return parseModuleDocument("/ws/telo.yaml", text).loaded.documents;
  }

  it("carries the step's node — its tag and its comments — into the other branch", () => {
    const next = applyEdit(docsOf(sequence), 0, {
      op: "relocate",
      pointer: "/steps/1/then/0",
      toPointer: "/steps/1/else",
      toIndex: 0,
    });
    const text = serializeModuleDocument(next);

    // It arrives ahead of the step that was there, with everything the author
    // attached to it — which a delete-then-insert would have re-serialized away.
    expect(text.indexOf("name: inner")).toBeLessThan(text.indexOf("name: other"));
    expect(text).toMatch(/# only when ok/);
    expect(text).toMatch(/invoke: !ref beta # trailing/);
    // And it is gone from where it was. An emptied block sequence serializes as
    // `[]` — the branch is still declared, which is what keeps it a legal drop
    // target rather than a key the next edit would have to recreate.
    expect(text).toMatch(/then:\s*\n(\s*#[^\n]*\n)?\s*\[\]/);
  });

  it("resolves the destination BEFORE the removal shifts it", () => {
    // `/steps/1/...` runs through the sequence the item is leaving, so removing
    // item 0 first would leave the destination path naming a different step.
    const next = applyEdit(docsOf(sequence), 0, {
      op: "relocate",
      pointer: "/steps/0",
      toPointer: "/steps/1/then",
      toIndex: 0,
    });
    const text = serializeModuleDocument(next);
    // It landed at the head of `then`, which only holds if `/steps/1/then` was
    // read against the pre-removal document.
    expect(text.indexOf("name: first")).toBeLessThan(text.indexOf("name: inner"));
    expect(text).toMatch(/then:\s*\n(\s*#[^\n]*\n)?\s*- name: first/);
    // The branch step is still whole — the destination was not misread as its
    // own `then`, and nothing was written over `else`.
    expect(text).toMatch(/else:\s*\n\s*- name: other/);
  });

  it("clamps a drop past the end, as a move does", () => {
    const next = applyEdit(docsOf(sequence), 0, {
      op: "relocate",
      pointer: "/steps/1/else/0",
      toPointer: "/steps/1/then",
      toIndex: 99,
    });
    const text = serializeModuleDocument(next);
    expect(text.indexOf("name: inner")).toBeLessThan(text.indexOf("name: other"));
  });

  it("leaves the document alone when either end is not a sequence", () => {
    const before = serializeModuleDocument(docsOf(sequence));
    // A branch the author never wrote — the case the step list refuses to offer
    // as a drop target, guarded here too so a stale view cannot invent one.
    const missing = applyEdit(docsOf(sequence), 0, {
      op: "relocate",
      pointer: "/steps/0",
      toPointer: "/steps/1/finally",
      toIndex: 0,
    });
    expect(serializeModuleDocument(missing)).toBe(before);
  });

  it("refuses a destination inside the item being moved", () => {
    // Splicing a node into its own descendant produces a cyclic tree nothing
    // can serialize. The step list guards this too, but the operation is
    // exported as a general one and must not be able to produce that document.
    expect(() =>
      applyEdit(docsOf(sequence), 0, {
        op: "relocate",
        pointer: "/steps/1",
        toPointer: "/steps/1/then",
        toIndex: 0,
      }),
    ).toThrow(/inside the item being moved/);
  });

  it("refuses a relocate that is really a move", () => {
    // Two spellings of one edit is how the two drift; `move` is the one that
    // knows a within-sequence index shifts as the item leaves.
    expect(() =>
      applyEdit(docsOf(sequence), 0, {
        op: "relocate",
        pointer: "/steps/0",
        toPointer: "/steps",
        toIndex: 1,
      }),
    ).toThrow(/use move/);
  });
});
