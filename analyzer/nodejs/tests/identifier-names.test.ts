import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";

import { StaticAnalyzer } from "../src/analyzer.js";
import { checkName } from "../src/identifier-name.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A step-bearing runnable, the shape every `Run` composer has. */
const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "Run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: {
        "x-telo-step-context": { invoke: "invoke", value: "value" },
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "object" },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

/** A named shape: `capability: Telo.Type`, so its name denotes a type even
 *  though it is declared as a resource. */
const jsonSchemaDef = {
  kind: "Telo.Definition",
  metadata: { name: "Shape", module: "Run" },
  capability: "Telo.Type",
  schema: { type: "object", properties: { schema: { type: "object" } } },
} as unknown as ResourceManifest;

function analyze(...manifests: ResourceManifest[]) {
  return new StaticAnalyzer().analyze(
    withSyntheticPositions([sequenceDef, jsonSchemaDef, ...manifests]),
  );
}

const codes = (ds: { code?: string }[], code: string) => ds.filter((d) => d.code === code);

describe("checkName", () => {
  it("rejects every character a CEL identifier cannot carry, at both levels", () => {
    for (const bad of ["my-server", "my.server", "2fa", "has space", "a+b", ""]) {
      expect(checkName(bad, "value", "resource name")?.code, bad).toBe("INVALID_NAME");
      expect(checkName(bad, "type", "kind name")?.code, bad).toBe("INVALID_NAME");
    }
  });

  it("explains a hyphen by what CEL does with it, since that is the silent case", () => {
    const v = checkName("my-server", "value", "resource name");
    expect(v?.severity).toBe(DiagnosticSeverity.Error);
    expect(v?.message).toMatch(/subtraction/);
  });

  it("gives a type-level name the kind-grammar reason, not the CEL one", () => {
    // A module name is a kind prefix and never becomes a CEL identifier, so
    // citing CEL at it would be a confidently wrong explanation.
    const v = checkName("workflow-temporal", "type", "module name");
    expect(v?.code).toBe("INVALID_NAME");
    expect(v?.message).toMatch(/<Alias>\.<Kind>/);
    expect(v?.message).not.toMatch(/CEL/);
  });

  it("reserves every CEL keyword, not just the ones today's parser rejects in field position", () => {
    // `resources.in` is a ParseError while `resources.for` parses — which set
    // is which is a property of the parser, so both are refused.
    for (const kw of ["in", "for", "package", "true", "null"]) {
      expect(checkName(kw, "value", "step name")?.tier, kw).toBe("reserved");
    }
  });

  it("checks only the first character, so acronyms and digits pass", () => {
    for (const ok of ["httpApi", "httpAPI", "oauth2Client", "s3Bucket", "a", "x_1"]) {
      expect(checkName(ok, "value", "resource name"), ok).toBeUndefined();
    }
    for (const ok of ["HttpApi", "OAuthClient", "SQL", "AI", "Shape_2"]) {
      expect(checkName(ok, "type", "kind name"), ok).toBeUndefined();
    }
  });

  it("separates the two case tiers by severity, because only one is a style rule", () => {
    expect(checkName("myKind", "type", "kind name")).toMatchObject({
      code: "INVALID_TYPE_NAME",
      severity: DiagnosticSeverity.Error,
    });
    expect(checkName("MyThing", "value", "resource name")).toMatchObject({
      code: "NAME_CASE_CONVENTION",
      severity: DiagnosticSeverity.Warning,
    });
  });

  it("reports the worst tier only — a miscased unparseable name is one problem", () => {
    expect(checkName("My-Thing", "value", "resource name")?.tier).toBe("grammar");
  });
});

describe("validateIdentifierNames", () => {
  const app = (extra: Record<string, unknown> = {}) =>
    ({
      kind: "Telo.Application",
      metadata: { name: "NamesApp", module: "NamesApp" },
      ...extra,
    }) as unknown as ResourceManifest;

  it("warns on a PascalCase resource instance and on a PascalCase step", () => {
    const diagnostics = analyze(
      app(),
      {
        kind: "Run.Sequence",
        metadata: { name: "MySequence", module: "NamesApp" },
        steps: [{ name: "DoThing", value: {} }],
      } as unknown as ResourceManifest,
    );
    const warnings = codes(diagnostics, "NAME_CASE_CONVENTION");
    expect(warnings.map((d) => d.message)).toEqual([
      expect.stringMatching(/resource name 'MySequence'/),
      expect.stringMatching(/step name 'DoThing'/),
    ]);
    expect(warnings.every((d) => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it("pins a step diagnostic to the step, not to its owning resource", () => {
    const diagnostics = analyze(
      app(),
      {
        kind: "Run.Sequence",
        metadata: { name: "seq", module: "NamesApp" },
        steps: [{ name: "first", value: {} }, { name: "Second", value: {} }],
      } as unknown as ResourceManifest,
    );
    const warning = codes(diagnostics, "NAME_CASE_CONVENTION")[0];
    expect(warning?.data?.path).toBe("steps[1].name");
  });

  it("errors on a lowercase kind name, a lowercase module name and a lowercase import alias", () => {
    const diagnostics = analyze(
      {
        kind: "Telo.Application",
        metadata: { name: "namesApp", module: "namesApp" },
      } as unknown as ResourceManifest,
      {
        kind: "Telo.Definition",
        metadata: { name: "widget", module: "namesApp" },
        capability: "Telo.Invocable",
        schema: { type: "object" },
      } as unknown as ResourceManifest,
      {
        kind: "Telo.Import",
        metadata: { name: "run", module: "namesApp" },
        source: "../run",
      } as unknown as ResourceManifest,
    );
    const errors = codes(diagnostics, "INVALID_TYPE_NAME");
    expect(errors.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/module name 'namesApp'/),
        expect.stringMatching(/kind name 'widget'/),
        expect.stringMatching(/import alias 'run'/),
      ]),
    );
    expect(errors.every((d) => d.severity === DiagnosticSeverity.Error)).toBe(true);
  });

  it("treats a Telo.Type resource as type-level, since its name denotes a shape", () => {
    const diagnostics = analyze(
      app(),
      {
        kind: "Run.Shape",
        metadata: { name: "Order", module: "NamesApp" },
        schema: { type: "object" },
      } as unknown as ResourceManifest,
    );
    expect(codes(diagnostics, "NAME_CASE_CONVENTION")).toEqual([]);
    expect(codes(diagnostics, "INVALID_TYPE_NAME")).toEqual([]);

    const lower = analyze(
      app(),
      {
        kind: "Run.Shape",
        metadata: { name: "order", module: "NamesApp" },
        schema: { type: "object" },
      } as unknown as ResourceManifest,
    );
    expect(codes(lower, "INVALID_TYPE_NAME")).toHaveLength(1);
  });

  it("checks the config contract's keys, which reach CEL through the same space", () => {
    const diagnostics = analyze(
      app({
        variables: { "API-URL": { env: "API_URL", type: "string" } },
        secrets: { Token: { env: "TOKEN", type: "string" } },
        ports: { Http: { env: "PORT" } },
      }),
    );
    expect(codes(diagnostics, "INVALID_NAME").map((d) => d.data?.path)).toEqual([
      "variables.API-URL",
    ]);
    expect(codes(diagnostics, "NAME_CASE_CONVENTION").map((d) => d.data?.path)).toEqual([
      "secrets.Token",
      "ports.Http",
    ]);
  });

  it("says nothing about an imported library's names, which the consumer cannot fix", () => {
    const diagnostics = analyze(
      app(),
      {
        kind: "Telo.Import",
        metadata: { name: "Dep", module: "NamesApp" },
        source: "../dep",
        // The loader stamps a forwarded manifest with the library it came from.
        resolvedModuleName: "Dep",
      } as unknown as ResourceManifest,
      {
        kind: "Run.Sequence",
        metadata: { name: "TheirBadName", module: "Dep" },
        steps: [{ name: "TheirBadStep", value: {} }],
      } as unknown as ResourceManifest,
    );
    expect(codes(diagnostics, "NAME_CASE_CONVENTION")).toEqual([]);
  });

  it("says nothing about a name inline extraction synthesized", () => {
    const diagnostics = analyze(
      app(),
      {
        kind: "Run.Sequence",
        metadata: {
          name: "TestAdd_steps_0_invoke",
          module: "NamesApp",
          xTeloOrigin: { parentKind: "Run.Sequence", parentName: "testAdd", pathFromParent: "steps[0].invoke" },
        },
        steps: [],
      } as unknown as ResourceManifest,
    );
    expect(codes(diagnostics, "NAME_CASE_CONVENTION")).toEqual([]);
  });

  it("accepts the convention applied throughout", () => {
    const diagnostics = analyze(
      app({ variables: { apiUrl: { env: "API_URL", type: "string" } } }),
      {
        kind: "Run.Sequence",
        metadata: { name: "announceStartup", module: "NamesApp" },
        steps: [{ name: "buildMessage", value: {} }],
      } as unknown as ResourceManifest,
    );
    for (const code of ["INVALID_NAME", "INVALID_TYPE_NAME", "NAME_CASE_CONVENTION"]) {
      expect(codes(diagnostics, code), code).toEqual([]);
    }
  });
});
