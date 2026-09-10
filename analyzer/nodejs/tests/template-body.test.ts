import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { DiagnosticSeverity } from "../src/types.js";

/**
 * A template body's reference surface: entry names, dispatch slots and the ref
 * slots inside each entry. Every case here used to pass `telo check` and fail
 * at boot, in the kernel's own words — or in a consumer's file.
 */

const ref = (source: string) => ({ __tagged: true, engine: "ref", source });
const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

const queryKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Query", module: "sql" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
      sql: { type: "string" },
    },
  },
} as unknown as ResourceManifest;

const connectionKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "sql" },
  capability: "Telo.Service",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const apiKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "http" },
  capability: "Telo.Mount",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

function template(overrides: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Op", module: "lib" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: { name: { type: "string" } } },
    resources: [{ kind: "sql.Query", metadata: { name: "query" }, sql: "SELECT 1" }],
    invoke: ref("query"),
    ...overrides,
  } as unknown as ResourceManifest;
}

function analyze(...manifests: ResourceManifest[]) {
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests));
}

const codes = (diags: { code: string }[], code: string) => diags.filter((d) => d.code === code);

describe("template body: dispatch slots", () => {
  it("accepts `!ref` to a literal-named sibling", () => {
    const diags = analyze(queryKind, template({}));
    expect(
      diags.filter((d) =>
        [
          "INVALID_REFERENCE_FORM",
          "TEMPLATE_DISPATCH_UNKNOWN",
          "DEPRECATED_TEMPLATE_ENTRY_NAME",
          "DEPRECATED_TEMPLATE_DISPATCH_FORM",
        ].includes(d.code),
      ),
    ).toEqual([]);
  });

  it("deprecates a CEL-named entry, since nothing can `!ref` it", () => {
    const diags = analyze(
      queryKind,
      template({
        resources: [{ kind: "sql.Query", metadata: { name: cel("self.name + '-query'") } }],
      }),
    );
    const dynamic = codes(diags, "DEPRECATED_TEMPLATE_ENTRY_NAME");
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].data?.path).toBe("resources[0].metadata.name");
    // The dispatch miss is NOT reported beside it — the dynamic entry is the
    // one meant, and one diagnostic per line is the point.
    expect(codes(diags, "TEMPLATE_DISPATCH_UNKNOWN")).toEqual([]);
  });

  it("deprecates the `{ kind, name }` object form at every dispatch slot", () => {
    for (const slot of ["invoke", "run", "provide", "mount"]) {
      const diags = analyze(
        queryKind,
        template({ invoke: undefined, [slot]: { kind: "sql.Query", name: "query" } }),
      );
      const form = codes(diags, "DEPRECATED_TEMPLATE_DISPATCH_FORM");
      expect(form, slot).toHaveLength(1);
      expect(form[0].data?.path).toBe(slot);
      expect(form[0].message).toContain("{ kind, name }");
    }
  });

  it("deprecates a bare string at a dispatch slot", () => {
    const diags = analyze(queryKind, template({ invoke: "query" }));
    const form = codes(diags, "DEPRECATED_TEMPLATE_DISPATCH_FORM");
    expect(form).toHaveLength(1);
    expect(form[0].message).toContain("the string 'query'");
  });

  it("keeps both legacy spellings at WARNING, because the kernel still reads them", () => {
    // Published artifacts carry them — refusing them here would report a
    // dependency's valid manifest as an error the consumer cannot fix, and
    // refusing them at the kernel broke every app pinning such a version.
    const diags = analyze(
      queryKind,
      template({
        resources: [{ kind: "sql.Query", metadata: { name: cel("self.name + '-query'") } }],
        invoke: { kind: "sql.Query", name: "query" },
      }),
    );
    const legacy = diags.filter(
      (d) =>
        d.code === "DEPRECATED_TEMPLATE_ENTRY_NAME" ||
        d.code === "DEPRECATED_TEMPLATE_DISPATCH_FORM",
    );
    expect(legacy).toHaveLength(2);
    for (const d of legacy) expect(d.severity).toBe(DiagnosticSeverity.Warning);
  });

  it("reports a `!ref` that names no entry, at every slot, with the nearest name", () => {
    for (const slot of ["invoke", "run", "provide", "mount"]) {
      const diags = analyze(queryKind, template({ invoke: undefined, [slot]: ref("querry") }));
      const unknown = codes(diags, "TEMPLATE_DISPATCH_UNKNOWN");
      expect(unknown, slot).toHaveLength(1);
      expect(unknown[0].message).toContain("Available: query");
      expect(unknown[0].data?.fix).toEqual({ replacement: "query" });
    }
  });

  it("resolves `Self.<entry>` as the local entry", () => {
    const diags = analyze(queryKind, template({ invoke: ref("Self.query") }));
    expect(codes(diags, "TEMPLATE_DISPATCH_UNKNOWN")).toEqual([]);
  });

  it("does NOT judge the target's capability", () => {
    // The kernel tests METHOD PRESENCE at dispatch, so a declared capability
    // says nothing about whether a dispatch works. A rule here rejected
    // `Ai.Buffered`, a shipping module dispatching `invoke:` to a
    // `Run.Sequence` — declared `Telo.Runnable`, and implementing `invoke()`
    // over an inputs/outputs contract, which runs correctly.
    const diags = analyze(
      queryKind,
      connectionKind,
      template({
        resources: [{ kind: "sql.Connection", metadata: { name: "db" } }],
        invoke: ref("db"),
      }),
    );
    expect(diags.filter((d) => d.code.startsWith("TEMPLATE_DISPATCH"))).toEqual([]);
  });
});

describe("template body: reference slots inside entries", () => {
  it("refuses the `{ kind, name }` object form at an entry's ref slot", () => {
    const diags = analyze(
      queryKind,
      connectionKind,
      template({
        resources: [
          { kind: "sql.Connection", metadata: { name: "db" } },
          {
            kind: "sql.Query",
            metadata: { name: "query" },
            connection: { kind: "sql.Connection", name: "db" },
          },
        ],
      }),
    );
    const form = codes(diags, "INVALID_REFERENCE_FORM");
    expect(form).toHaveLength(1);
    expect(form[0].data?.path).toBe("resources[1].connection");
    expect(form[0].message).toContain("!ref db");
  });

  it("reports a `!ref` naming neither a sibling nor a module resource", () => {
    const diags = analyze(
      queryKind,
      connectionKind,
      template({
        resources: [
          { kind: "sql.Connection", metadata: { name: "db" } },
          { kind: "sql.Query", metadata: { name: "query" }, connection: ref("dbb") },
        ],
      }),
    );
    const unknown = codes(diags, "TEMPLATE_REF_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].data?.path).toBe("resources[1].connection");
    expect(unknown[0].data?.fix).toEqual({ replacement: "db" });
  });

  it("accepts a `!ref` to a sibling, to a module-level resource, and a CEL passthrough", () => {
    const diags = analyze(
      queryKind,
      connectionKind,
      { kind: "sql.Connection", metadata: { name: "shared", module: "lib" } } as ResourceManifest,
      template({
        resources: [
          { kind: "sql.Connection", metadata: { name: "db" } },
          { kind: "sql.Query", metadata: { name: "query" }, connection: ref("db") },
          { kind: "sql.Query", metadata: { name: "other" }, connection: ref("shared") },
          { kind: "sql.Query", metadata: { name: "passed" }, connection: cel("self.connection") },
        ],
      }),
    );
    expect(codes(diags, "TEMPLATE_REF_UNKNOWN")).toEqual([]);
    expect(codes(diags, "INVALID_REFERENCE_FORM")).toEqual([]);
  });

  it("leaves a published dependency's body alone", () => {
    const diags = analyze(
      queryKind,
      { kind: "Telo.Import", metadata: { name: "Lib", resolvedModuleName: "lib", module: "app" }, source: "lib" } as unknown as ResourceManifest,
      template({ invoke: { kind: "sql.Query", name: "query" } }),
      { kind: "Telo.Application", metadata: { name: "app" } } as unknown as ResourceManifest,
    );
    expect(codes(diags, "INVALID_REFERENCE_FORM")).toEqual([]);
  });
});
