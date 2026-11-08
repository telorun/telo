// The feature catalogue: one generator per Telo feature, each producing the plain files of one
// application at size n. Nothing here is a `!for-each` over n -- that would measure the loop
// beside the feature -- so every size is written out in full.

export const SIZE_CLASSES = {
  count: [1, 10, 100, 1000],
  depth: [1, 4, 16, 64, 256],
  dimension: [1, 2, 4, 8, 16],
};

const range = (n) => Array.from({ length: n }, (_, i) => i);
const lines = (n, line) => range(n).map(line).join("\n");
// A generated directory sits two levels below `generated/`, an application's own one level.
export const rootFromApp = "../../../../";
export const rootFromLibrary = "../../../../../";

const tracing = `logging:
  sinks:
    - sink: { kind: Telo.FileSink, destination: spans.jsonl, encoding: json }
      when: !cel "variables.trace"
tracing:
  sinks:
    - sink: { kind: Telo.LogTraceSink }
      when: !cel "variables.trace"`;

// The application document every generated app opens with. `variables` and `top` are extra
// lines (already indented for `variables`) appended to the common ones.
export function application(name, { imports = {}, variables = "", top = "", targets = ["!ref main"] } = {}) {
  const importLines = Object.entries(imports)
    .map(([alias, source]) => `  ${alias}: ${source}`)
    .join("\n");
  return `kind: Telo.Application
metadata: { name: ${name} }
${top ? `${top}\n` : ""}${importLines ? `imports:\n${importLines}\n` : ""}variables:
  trace: { env: TRACE, type: boolean, default: false }
${variables ? `${variables}\n` : ""}${tracing}
targets:
${targets.map((t) => `  - ${t}`).join("\n")}
`;
}

export const main = (steps) => `---
kind: Telo.Sequence
metadata: { name: main }
steps:
${steps}
`;

export const runImport = { Run: `${rootFromApp}modules/run` };
export const doneStep = "  - { name: done, value: 1 }";

function library(name, { imports = {}, exportsBlock = "", body = "" }) {
  const importLines = Object.entries(imports)
    .map(([alias, source]) => `  ${alias}: ${source}`)
    .join("\n");
  return `kind: Telo.Library
metadata: { name: ${name} }
${importLines ? `imports:\n${importLines}\n` : ""}${exportsBlock}${body ? `---\n${body}` : ""}`;
}

const upRun = `${rootFromLibrary}modules/run`;

const pascal = (s) => s[0].toUpperCase() + s.slice(1);

function chooser(i, ifName, switchName) {
  return i % 2 === 0
    ? `--- !if
metadata: { name: c${i} }
if: !cel "variables.${ifName}"
then: { kind: Run.Value, value: { branch: a } }
else: { kind: Run.Value, value: { branch: b } }`
    : `--- !switch
metadata: { name: c${i} }
switch: !cel "variables.${switchName}"
cases:
  a: { kind: Run.Value, value: { branch: a } }
  b: { kind: Run.Value, value: { branch: b } }`;
}

export const FEATURES = [
  {
    name: "resourceCount",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("Baseline", { imports: runImport }) +
        main(doneStep) +
        lines(n, (i) => `---\nkind: Run.Value\nmetadata: { name: v${i} }\nvalue: { n: ${i} }`) +
        "\n",
    }),
  },
  {
    name: "choiceCount",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("ChoiceCount", {
          imports: runImport,
          variables: `  flag: { env: FLAG, type: boolean, default: true }
  mode: { env: MODE, type: string, enum: [a, b], default: a }`,
        }) +
        main(doneStep) +
        lines(n, (i) => chooser(i, "flag", "mode")) +
        "\n",
    }),
  },
  {
    name: "choiceDimensions",
    sizes: "dimension",
    generate: (n) => ({
      "telo.yaml":
        application("ChoiceDimensions", {
          imports: runImport,
          variables: lines(n, (i) =>
            i % 2 === 0
              ? `  d${i}: { env: D${i}, type: boolean, default: true }`
              : `  d${i}: { env: D${i}, type: string, enum: [a, b], default: a }`,
          ),
        }) +
        main(doneStep) +
        lines(n, (i) => chooser(i, `d${i}`, `d${i}`)) +
        "\n",
    }),
  },
  {
    name: "forEachIterations",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("ForEachIterations", { imports: { Fx: "./lib" }, targets: ["!ref fan"] }) +
        `---\nkind: Fx.Fan\nmetadata: { name: fan }\nitems: [${range(n).map((i) => `item${i}`).join(", ")}]\n`,
      "lib/telo.yaml": library("Fans", {
        imports: { Run: upRun },
        body: `kind: Telo.Definition
metadata: { name: Fan }
capability: Telo.Runnable
schema:
  type: object
  required: [items]
  properties:
    items: { type: array, items: { type: string } }
resources:
  - !for-each
    metadata: { name: members }
    in: !cel "self.items"
    emit:
      kind: Telo.Sequence
      steps:
        - { name: s, value: !cel "each.value" }
targets:
  - !for-each
    in: !cel "self.items"
    emit: !ref members[each.index]
`,
      }),
    }),
  },
  {
    name: "forEachNesting",
    sizes: "depth",
    generate: (n) => {
      // Depth n: the loop over `self.l` binds b0, each deeper loop walks the `c` list of the one
      // above, and the innermost elements are strings.
      const element = (k) => (k === n ? "{ type: string }" : `{ type: object, required: [c], properties: { c: { type: array, items: ${element(k + 1)} } } }`);
      const data = (k) => (k === n ? "x" : `{ c: [${data(k + 1)}] }`);
      const loop = (k) =>
        k === n
          ? `{ value: !cel "b${n - 1}.value" }`
          : `!for-each { in: !cel "${k === 0 ? "self.l" : `b${k - 1}.value.c`}", as: b${k}, emit: ${loop(k + 1)} }`;
      return {
        "telo.yaml":
          application("ForEachNesting", { imports: { Fx: "./lib" }, targets: ["!ref nest"] }) +
          `---\nkind: Fx.Nest\nmetadata: { name: nest }\nl: [${data(1)}]\n`,
        "lib/telo.yaml": library("Nests", {
          imports: { Run: upRun },
          body: `kind: Telo.Definition
metadata: { name: Nest }
capability: Telo.Runnable
schema:
  type: object
  required: [l]
  properties:
    l: { type: array, items: ${element(1)} }
resources:
  - kind: Telo.Sequence
    metadata: { name: body }
    steps:
      - ${loop(0)}
run: !ref body
`,
        }),
      };
    },
  },
  {
    name: "templateConsumers",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("TemplateConsumers", { imports: { Fx: "./lib" }, targets: ["!ref t0"] }) +
        lines(n, (i) => `---\nkind: Fx.Task\nmetadata: { name: t${i} }`) +
        "\n",
      "lib/telo.yaml": library("Tasks", {
        imports: { Run: upRun },
        body: `kind: Telo.Definition
metadata: { name: Task }
capability: Telo.Runnable
schema: { type: object }
resources:
  - kind: Telo.Sequence
    metadata: { name: body }
    steps:
      - { name: s, value: 1 }
run: !ref body
`,
      }),
    }),
  },
  {
    name: "extendsDepth",
    sizes: "depth",
    generate: (n) => ({
      "telo.yaml":
        application("ExtendsDepth", { imports: { Kinds: "./lib" } }) +
        main(`  - { name: call, invoke: !ref leaf }`) +
        `---\nkind: Kinds.K${n}\nmetadata: { name: leaf }\n`,
      "lib/telo.yaml": library("Kinds", {
        imports: { Run: upRun },
        body: `kind: Telo.Definition
metadata: { name: K0 }
capability: Telo.Invocable
schema: { type: object }
resources:
  - { kind: Run.Value, metadata: { name: v }, value: 1 }
invoke: !ref v
${lines(n, (i) => `---\nkind: Telo.Definition\nmetadata: { name: K${i + 1} }\nextends: Self.K${i}\nschema: { type: object }`)}
`,
      }),
    }),
  },
  {
    name: "importDepth",
    sizes: "depth",
    generate: (n) => {
      const files = {
        "telo.yaml": application("ImportDepth", { imports: { L: "./l0" } }) + main(`  - { name: call, invoke: !ref L.v }`),
      };
      for (let i = 0; i < n; i++) {
        files[`l${i}/telo.yaml`] =
          i === n - 1
            ? library(`L${i}`, {
                imports: { Run: upRun },
                exportsBlock: "exports: { resources: [v] }\n",
                body: "kind: Run.Value\nmetadata: { name: v }\nvalue: 1\n",
              })
            : library(`L${i}`, {
                imports: { Next: `../l${i + 1}` },
                exportsBlock: "exports: { resources: [Next.v] }\n",
              });
      }
      return files;
    },
  },
  ...[
    ["importWidth", "isolated"],
    ["importWidthShared", "shared"],
  ].map(([name, lifecycle]) => ({
    name,
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application(pascal(name), {
          imports: Object.fromEntries(range(n).map((i) => [`L${i}`, "./lib"])),
        }) + main(`  - { name: call, invoke: !ref L0.v }`),
      "lib/telo.yaml": library("Leaf", {
        imports: { Run: upRun },
        exportsBlock: `lifecycle: ${lifecycle}\nexports: { resources: [v] }\n`,
        body: "kind: Run.Value\nmetadata: { name: v }\nvalue: 1\n",
      }),
    }),
  })),
  {
    name: "celCount",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("CelCount", { imports: runImport }) +
        main(`  - { name: call, invoke: !ref v }`) +
        `---\nkind: Run.Value\nmetadata: { name: v }\nvalue:\n${lines(n, (i) => `  k${i}: !cel "1 + ${i}"`)}\n`,
    }),
  },
  {
    name: "celSize",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("CelSize", { imports: runImport }) +
        main(`  - { name: size, value: !cel "[${range(n).join(", ")}].size()" }`),
    }),
  },
  {
    name: "stepCount",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml": application("StepCount") + main(lines(n, (i) => `  - { name: s${i}, value: ${i} }`)),
    }),
  },
  {
    name: "tryNesting",
    sizes: "depth",
    generate: (n) => {
      const nest = (k) =>
        k === n
          ? "{ name: inner, value: 1 }"
          : `{ name: t${k}, try: [${nest(k + 1)}], catch: [{ name: c${k}, value: 0 }] }`;
      return { "telo.yaml": application("TryNesting") + main(`  - ${nest(0)}`) };
    },
  },
  {
    name: "scopeMembers",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("ScopeMembers", { imports: runImport }) +
        `---\nkind: Telo.Sequence\nmetadata: { name: main }\nwith:\n${lines(n, (i) => `  - { kind: Run.Value, metadata: { name: m${i} }, value: ${i} }`)}\nsteps:\n  - { name: call, invoke: !ref m0 }\n`,
    }),
  },
  {
    name: "contractSchemaSize",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("ContractSchemaSize", { imports: runImport }) +
        main(`  - { name: call, invoke: !ref v, inputs: { p0: a } }`) +
        `---\nkind: Run.Value\nmetadata: { name: v }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
${lines(n, (i) => `      p${i}: { type: string }`)}
value: !cel "inputs.p0"\n`,
    }),
  },
  {
    name: "moduleFunctionCalls",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("ModuleFunctionCalls", { imports: { F: "./lib" } }) +
        main(`  - { name: calls, value: !cel "[${range(n).map((i) => `F.inc(${i})`).join(", ")}].size()" }`),
      "lib/telo.yaml": library("Fns", {
        exportsBlock: "exports: { resources: [inc] }\n",
        body: `kind: Telo.Function
metadata: { name: inc }
params:
  - { name: x, schema: { type: integer } }
returns:
  schema: { type: integer }
body: !cel "x + 1"
`,
      }),
    }),
  },
  {
    name: "textCatalogSize",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        application("TextCatalogSize", {
          top: "lang: en",
        }).replace(
          "targets:",
          `translations:
  catalogs:
    - kind: Telo.TextTranslations
      lang: pl
      texts:
${lines(n, (i) => `        - { text: "Text ${i}", translation: "Tekst ${i}" }`)}
targets:`,
        ) + main(doneStep),
    }),
  },
];

export const featureByName = (name, features = FEATURES) => features.find((f) => f.name === name);
