import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import {
  applicationSourceAnnotationProblems,
  readApplicationSourceSlot,
} from "../src/application-source-slot.js";
import { collectApplicationSources } from "../src/child-application.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports(url: string) {
      return url.startsWith("/");
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

/** A kind running a child application, named by nothing the analyzer knows. */
const SUPERVISOR = `kind: Telo.Library
metadata: { name: Supervision, version: 1.0.0 }
---
kind: Telo.Definition
metadata: { name: Child }
capability: Telo.Service
controllers: ["pkg:telo/local/js?path=./child.mjs"]
schema:
  type: object
  properties:
    from:
      type: string
      x-telo-application-source:
        variables: /inputs/values
        secrets: /secretValues
        ports: /listen
        needs: /needs
    inputs:
      type: object
      properties:
        values: { type: object, additionalProperties: true, x-telo-eval: compile }
    secretValues: { type: object, additionalProperties: true, x-telo-eval: compile }
    listen: { type: object, additionalProperties: true, x-telo-eval: compile }
    needs:
      type: object
      x-telo-eval: compile
      additionalProperties:
        anyOf:
          - x-telo-ref: { kind: Telo.Provider, use: dependency }
          - type: object
---
kind: Telo.Definition
metadata: { name: Scope }
capability: Telo.Runnable
controllers: ["pkg:telo/local/js?path=./scope.mjs"]
schema:
  type: object
  properties:
    with: { type: array, items: { type: object }, x-telo-scope: /steps }
    steps: { type: array }
`;

const CHILD = `kind: Telo.Application
metadata: { name: Child, version: 1.0.0 }
imports:
  Sup: ../../sup/telo.yaml
variables:
  who: { env: WHO, type: string, default: nobody }
  count: { env: COUNT, type: integer, default: 1 }
secrets:
  token: { env: TOKEN, type: string }
ports:
  http: { env: PORT, default: 8080 }
needs:
  state: { kind: Telo.DurableDirectory, parameters: { access: single-writer } }
  cache: { kind: Telo.DurableDirectory, optional: true }
---
kind: Sup.Child
metadata: { name: grandchild }
source: ./nowhere/telo.yaml
`;

const STORAGE = `kind: Telo.Library
metadata: { name: Storage, version: 1.0.0 }
exports: { resources: [dir] }
---
kind: Telo.DurableDirectory
metadata: { name: dir }
fields: { path: /var/storage }
`;

/** A kind extending the annotated one, and an unrelated kind of the same name. */
const PINNED = `kind: Telo.Library
metadata: { name: Pinning, version: 1.0.0 }
imports:
  Sup: ../../sup/telo.yaml
---
kind: Telo.Definition
metadata: { name: Pinned }
extends: Sup.Child
`;

const UNRELATED = `kind: Telo.Library
metadata: { name: Unrelated, version: 1.0.0 }
---
kind: Telo.Definition
metadata: { name: Child }
capability: Telo.Service
controllers: ["pkg:telo/local/js?path=./child.mjs"]
schema: { type: object, properties: { from: { type: string } } }
`;

const NEEDER = `kind: Telo.Library
metadata: { name: Needer, version: 1.0.0 }
needs:
  dir: { kind: Telo.DurableDirectory }
`;

const files = (parent: string): Record<string, string> => ({
  "/sup/telo.yaml": SUPERVISOR,
  "/app/pinned/telo.yaml": PINNED,
  "/app/unrelated/telo.yaml": UNRELATED,
  "/app/needer/telo.yaml": NEEDER,
  "/app/child/telo.yaml": CHILD,
  "/app/storage/telo.yaml": STORAGE,
  "/app/lib/telo.yaml": `kind: Telo.Library\nmetadata: { name: NotAnApp, version: 1.0.0 }\n`,
  "/app/telo.yaml": parent,
});

const parentApp = (body: string, extra = "") => `kind: Telo.Application
metadata: { name: Parent, version: 1.0.0 }
imports:
  Sup: ../sup/telo.yaml
  Store: ./storage/telo.yaml
${extra}---
${body}`;

async function loaded(parent: string) {
  return new Loader([inMemorySource(files(parent))]).loadGraph("/app/telo.yaml", { desugarImports: true });
}

/** Every diagnostic, as `[code, path, message]`. */
async function check(parent: string): Promise<Array<[string, string, string]>> {
  const graph = await loaded(parent);
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), {
      moduleDocuments: collectModuleDocuments(graph),
      applicationSources: collectApplicationSources(graph),
    })
    .map((d) => [String(d.code), String((d.data as { path?: string } | undefined)?.path), d.message]);
}

describe("the annotation's reader", () => {
  it("reads the field and the keys of each fed map", () => {
    expect(
      readApplicationSourceSlot({
        properties: { from: { type: "string", "x-telo-application-source": { variables: "/a/b", ports: "/p" } } },
      }),
    ).toEqual({ field: "from", feeds: { variables: ["a", "b"], ports: ["p"] } });
  });
});

describe("the annotation's strict half", () => {
  const problems = (properties: Record<string, unknown>) =>
    applicationSourceAnnotationProblems("Runner", { type: "object", properties }).map((p) => p.path);

  it("refuses a field that is not a literal string, and every malformed key", () => {
    expect(
      problems({
        from: {
          type: "integer",
          "x-telo-eval": "compile",
          "x-telo-application-source": { variables: "/vars", secrets: "/vars", ports: "/from", needs: "/none", bogus: "/x" },
        },
        vars: { type: "object" },
      }),
    ).toEqual([
      "schema.properties.from.type",
      "schema.properties.from.x-telo-eval",
      "schema.properties.from.x-telo-application-source",
      "schema.properties.from.x-telo-application-source.secrets",
      "schema.properties.from.x-telo-application-source.ports",
      "schema.properties.from.x-telo-application-source.needs",
    ]);
  });

  it("refuses the annotation below the top level, written twice, or not an object", () => {
    expect(
      problems({
        a: { type: "string", "x-telo-application-source": [] },
        b: { type: "string", "x-telo-application-source": {} },
        c: { type: "object", properties: { d: { type: "string", "x-telo-application-source": {} } } },
      }),
    ).toEqual([
      "schema.properties.a.x-telo-application-source",
      "schema.properties.b.x-telo-application-source",
      "schema.properties.c.properties.d.x-telo-application-source",
    ]);
  });
});

describe("the loader follows a child application's source", () => {
  it("loads the child the entry names, never the children the child names", async () => {
    const graph = await loaded(parentApp(`kind: Sup.Child\nmetadata: { name: child }\nfrom: ./child/telo.yaml\n`));
    const loads = graph.applicationSources?.get("/app/telo.yaml");
    const child = loads?.get("./child/telo.yaml");
    expect(child && "graph" in child ? child.graph.rootSource : child).toBe("/app/child/telo.yaml");
    expect(child && "graph" in child ? child.graph.applicationSources?.size : undefined).toBe(0);
    expect(graph.errors).toEqual([]);
  });

  it("resolves each kind through the declaring file's imports, inheritance included", async () => {
    const graph = await loaded(
      parentApp(
        `kind: Pin.Pinned
metadata: { name: pinned }
from: ./child/telo.yaml
---
kind: Other.Child
metadata: { name: unrelated }
from: ./unrelated/telo.yaml
`,
        `  Pin: ./pinned/telo.yaml
  Other: ./unrelated/telo.yaml
`,
      ),
    );
    expect([...(graph.applicationSources?.get("/app/telo.yaml")?.keys() ?? [])]).toEqual(["./child/telo.yaml"]);
  });
});

describe("a resource running a child application, held to what the child declares", () => {
  it("refuses every name no block of the child declares, in each fed map", async () => {
    const diagnostics = await check(
      parentApp(`kind: Sup.Child
metadata: { name: child }
from: ./child/telo.yaml
inputs: { values: { who: a, whom: b } }
secretValues: { tokn: x }
listen: { https: 1 }
needs: { stat: { path: /tmp/s } }
`),
    );
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["APPLICATION_INPUT_UNDECLARED", "inputs.values.whom"],
      ["APPLICATION_INPUT_UNDECLARED", "secretValues.tokn"],
      ["APPLICATION_INPUT_UNDECLARED", "listen.https"],
      ["APPLICATION_INPUT_UNDECLARED", "needs.stat"],
    ]);
    expect(diagnostics[0]![2]).toBe(
      "Sup.Child/child: 'inputs.values.whom' names no variable the application at './child/telo.yaml' " +
        "declares — it declares 'who', 'count'.",
    );
  });

  it("refuses a literal the child's declaration refuses, and types an expression by it", async () => {
    const diagnostics = await check(
      parentApp(`kind: Sup.Child
metadata: { name: child }
from: ./child/telo.yaml
inputs: { values: { who: 3, count: !cel "'two'" } }
listen: { http: 70000 }
`),
    );
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["CEL_TYPE_ERROR", "inputs.values.count"],
      ["SCHEMA_VIOLATION", "inputs.values.who"],
      ["SCHEMA_VIOLATION", "listen.http"],
    ]);
  });

  it("holds a need to the child's type: a field map, a whole forward, and an imported fulfilment", async () => {
    const diagnostics = await check(
      parentApp(
        `kind: Sup.Child
metadata: { name: fields }
from: ./child/telo.yaml
needs: { state: { extra: 1 } }
---
kind: Sup.Child
metadata: { name: forwards }
from: ./child/telo.yaml
needs: { state: !ref sharedDir, cache: !ref Store.dir }
---
kind: Sup.Child
metadata: { name: wrongType }
from: ./child/telo.yaml
needs: { state: !ref address }
`,
        `needs:
  sharedDir: { kind: Telo.DurableDirectory, parameters: { access: shared } }
  address: { kind: Telo.PublicUrl, parameters: { port: http } }
ports:
  http: { env: HTTP, default: 1 }
`,
      ),
    );
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["NEED_FIELD_UNDECLARED", "needs.state.extra"],
      ["NEED_SLOT_MISMATCH", "needs.state"],
      ["NEED_FORWARD_INCOMPATIBLE", "needs.state"],
      ["REFERENCE_KIND_MISMATCH", "needs.state"],
    ]);
  });

  it("refuses a source that does not resolve, or names no application, with the import codes", async () => {
    const diagnostics = await check(
      parentApp(`kind: Sup.Child
metadata: { name: gone }
from: ./missing/telo.yaml
---
kind: Sup.Child
metadata: { name: library }
from: ./lib/telo.yaml
---
kind: Sup.Child
metadata: { name: malformed }
from: not-a-source
`),
    );
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["IMPORT_UNRESOLVED", "from"],
      ["INVALID_IMPORT_TARGET", "from"],
      ["INVALID_IMPORT_SOURCE", "from"],
    ]);
    expect(diagnostics[1]![2]).toBe(
      "Sup.Child/library: cannot run './lib/telo.yaml': it is a Telo.Library, which is imported, " +
        "never run. Name the source of a Telo.Application.",
    );
  });

  it("judges a resource declared in a scope where it is written", async () => {
    const diagnostics = await check(
      parentApp(`kind: Sup.Scope
metadata: { name: scope }
with:
  - kind: Sup.Child
    metadata: { name: scoped }
    from: ./child/telo.yaml
    inputs: { values: { whoo: a } }
steps: []
`),
    );
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["APPLICATION_INPUT_UNDECLARED", "with[0].inputs.values.whoo"],
    ]);
  });

  it("refuses one durable directory forwarded whole to a library and to two child applications", async () => {
    const diagnostics = await check(`kind: Telo.Application
metadata: { name: Parent, version: 1.0.0 }
imports:
  Sup: ../sup/telo.yaml
  Needer:
    source: ./needer/telo.yaml
    needs: { dir: !ref stateDir }
needs:
  stateDir: { kind: Telo.DurableDirectory }
---
kind: Sup.Child
metadata: { name: first }
from: ./child/telo.yaml
needs: { state: !ref stateDir }
---
kind: Sup.Child
metadata: { name: second }
from: ./child/telo.yaml
needs: { state: !ref stateDir }
`);
    expect(diagnostics.map(([code, path]) => [code, path])).toEqual([
      ["NEED_DIRECTORY_FORWARDED_TWICE", "needs.state"],
      ["NEED_DIRECTORY_FORWARDED_TWICE", "needs.state"],
    ]);
    expect(diagnostics[0]![2]).toBe(
      "Durable directory 'stateDir' is forwarded whole to 3 needs — 'Needer.dir', 'first.state', " +
        "'second.state' — and each would write over the others' files. Give each its own directory; a " +
        "library that must share one with another declares that in one library, not by forwarding.",
    );
  });
});
