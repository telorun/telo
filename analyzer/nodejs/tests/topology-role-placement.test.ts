import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { topologyRoleProblems } from "../src/validate-topology-roles.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const matcher = () => ({ type: "string", "x-telo-topology-role": "matcher" });
const trigger = (use: unknown) => ({ "x-telo-ref": { kind: "Telo.Executable", use } });
const paths = (schema: Record<string, any>, authorSchema?: Record<string, any>) =>
  topologyRoleProblems({ metadata: { name: "K" }, schema }, authorSchema).map((p) => p.path);

describe("x-telo-topology-role: matcher placement", () => {
  it("accepts a matcher on an entry of a top-level entries list, written directly or through a local $ref", () => {
    const list = (path: unknown) => ({
      "x-telo-topology-role": "entries",
      type: "array",
      items: { properties: { path, handler: trigger("trigger.inbound") } },
    });
    expect(paths({ properties: { routes: list(matcher()) } })).toEqual([]);
    expect(
      paths({ properties: { routes: list({ $ref: "#/$defs/Path" }) }, $defs: { Path: matcher() } }),
    ).toEqual([]);
  });

  it("accepts a top-level matcher when a top-level trigger slot sits outside every entry list, a case map's included", () => {
    expect(paths({ properties: { every: matcher(), invoke: trigger("trigger.inbound") } })).toEqual([]);
    expect(paths({ properties: { every: matcher(), body: { properties: { run: trigger("trigger.consumer") } } } })).toEqual([]);
    expect(
      paths({
        properties: {
          every: matcher(),
          detach: { type: "boolean" },
          invoke: trigger({ by: "/detach", cases: { false: "call", true: "trigger.inbound" } }),
        },
      }),
    ).toEqual([]);
  });

  it("accepts a top-level matcher whose trigger the kind inherits", () => {
    const own = { properties: { every: matcher() } };
    expect(paths(own, { properties: { ...own.properties, invoke: trigger("trigger.inbound") } })).toEqual([]);
  });

  it("refuses a top-level matcher when no trigger slot sits outside an entry list", () => {
    expect(paths({ properties: { every: matcher(), store: trigger("dependency") } })).toEqual([
      "schema.properties.every.x-telo-topology-role",
    ]);
    expect(
      paths({
        properties: {
          label: matcher(),
          routes: {
            "x-telo-topology-role": "entries",
            type: "array",
            items: { properties: { handler: trigger("trigger.inbound") } },
          },
        },
      }),
    ).toEqual(["schema.properties.label.x-telo-topology-role"]);
  });

  it("refuses a matcher nested anywhere else", () => {
    expect(
      paths({
        properties: {
          invoke: trigger("trigger.inbound"),
          options: { properties: { every: matcher() } },
          list: { type: "array", items: { properties: { key: matcher() } } },
        },
      }),
    ).toEqual([
      "schema.properties.options.properties.every.x-telo-topology-role",
      "schema.properties.list.items.properties.key.x-telo-topology-role",
    ]);
  });

  it("refuses a misplaced matcher under a property named like a data keyword", () => {
    expect(
      paths({
        properties: {
          invoke: trigger("trigger.inbound"),
          default: { properties: { every: matcher() } },
          examples: { properties: { every: matcher() } },
          enum: { properties: { every: matcher() } },
        },
      }),
    ).toEqual([
      "schema.properties.default.properties.every.x-telo-topology-role",
      "schema.properties.examples.properties.every.x-telo-topology-role",
      "schema.properties.enum.properties.every.x-telo-topology-role",
    ]);
  });
});

describe("TOPOLOGY_ROLE_MISPLACED", () => {
  it("warns at a kind of the entry's own modules that writes the misplaced matcher", () => {
    const diagnostics = new StaticAnalyzer()
      .analyze(
        withSyntheticPositions([
          { kind: "Telo.Library", metadata: { name: "Lib", module: "Lib" } },
          {
            kind: "Telo.Definition",
            metadata: { name: "Thing", module: "Lib" },
            capability: "Telo.Provider",
            schema: { type: "object", properties: { label: matcher() } },
          },
          {
            kind: "Telo.Definition",
            metadata: { name: "Imported", module: "Dep" },
            capability: "Telo.Provider",
            schema: { type: "object", properties: { label: matcher() } },
          },
        ] as unknown as ResourceManifest[]),
      )
      .filter((d) => d.code === "TOPOLOGY_ROLE_MISPLACED");
    expect(
      diagnostics.map((d) => [
        d.severity,
        (d.data as { resource: { name: string } }).resource.name,
        (d.data as { path: string }).path,
      ]),
    ).toEqual([[DiagnosticSeverity.Warning, "Thing", "schema.properties.label.x-telo-topology-role"]]);
  });
});

describe("TOPOLOGY_ROLE_UNKNOWN", () => {
  const problems = (schema: Record<string, any>) =>
    topologyRoleProblems({ metadata: { name: "K" }, schema }).map((p) => [p.code, p.path, p.message]);

  it("reports a role outside the vocabulary wherever the schema writes it, suggesting the nearest role", () => {
    const found = problems({
      properties: {
        steps: { type: "array", "x-telo-topology-role": "stepz" },
        options: { properties: { mode: { $ref: "#/$defs/Mode" } } },
      },
      $defs: { Mode: { type: "string", "x-telo-topology-role": "selector" } },
    });
    expect(found.map(([code, path]) => [code, path])).toEqual([
      ["TOPOLOGY_ROLE_UNKNOWN", "schema.properties.steps.x-telo-topology-role"],
      ["TOPOLOGY_ROLE_UNKNOWN", "schema.$defs.Mode.x-telo-topology-role"],
    ]);
    expect(found[0][2]).toContain("Did you mean 'steps'?");
    expect(found[1][2]).not.toContain("Did you mean");
    expect(found[1][2]).toContain("The roles are: steps, invoke, inputs,");
  });

  it("reports a value that is not a string, null included", () => {
    expect(
      problems({
        properties: {
          a: { "x-telo-topology-role": 3 },
          b: { "x-telo-topology-role": null },
        },
      }).map(([code, path, message]) => [code, path, String(message).split(" at ")[0]]),
    ).toEqual([
      ["TOPOLOGY_ROLE_UNKNOWN", "schema.properties.a.x-telo-topology-role", "'K' declares `x-telo-topology-role: 3`"],
      ["TOPOLOGY_ROLE_UNKNOWN", "schema.properties.b.x-telo-topology-role", "'K' declares `x-telo-topology-role: null`"],
    ]);
  });

  it("reads a misspelled matcher as no role: unknown, never also misplaced", () => {
    expect(
      problems({ properties: { label: { type: "string", "x-telo-topology-role": "matchr" } } }).map(
        ([code]) => code,
      ),
    ).toEqual(["TOPOLOGY_ROLE_UNKNOWN"]);
  });

  it("says nothing about every role in the vocabulary", () => {
    expect(
      problems({
        properties: Object.fromEntries(
          ["steps", "invoke", "inputs", "predicate", "discriminator", "branch", "case-map", "branch-list", "entries", "handler"].map(
            (role) => [role, { "x-telo-topology-role": role }],
          ),
        ),
      }),
    ).toEqual([]);
  });

  it("warns at a kind of the entry's own modules only", () => {
    const role = { type: "string", "x-telo-topology-role": "stpes" };
    const diagnostics = new StaticAnalyzer()
      .analyze(
        withSyntheticPositions([
          { kind: "Telo.Library", metadata: { name: "Lib", module: "Lib" } },
          {
            kind: "Telo.Definition",
            metadata: { name: "Thing", module: "Lib" },
            capability: "Telo.Provider",
            schema: { type: "object", properties: { label: role } },
          },
          {
            kind: "Telo.Definition",
            metadata: { name: "Imported", module: "Dep" },
            capability: "Telo.Provider",
            schema: { type: "object", properties: { label: role } },
          },
        ] as unknown as ResourceManifest[]),
      )
      .filter((d) => d.code === "TOPOLOGY_ROLE_UNKNOWN");
    expect(
      diagnostics.map((d) => [
        d.severity,
        (d.data as { resource: { name: string } }).resource.name,
        (d.data as { path: string }).path,
      ]),
    ).toEqual([[DiagnosticSeverity.Warning, "Thing", "schema.properties.label.x-telo-topology-role"]]);
  });
});
