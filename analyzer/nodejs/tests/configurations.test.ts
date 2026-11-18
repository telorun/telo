import { collectFilePositions } from "../src/diagnostic-location.js";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FindingOrder } from "../src/finding-order.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { readChoices } from "../src/choice-reading.js";
import { choiceScopeOf } from "../src/choice-scope.js";
import { registeredNeedTable } from "../src/validate-needs.js";
import { describeConfigurations, enumerateConfigurations, type Dimension } from "../src/configuration-dimensions.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { frozenDocuments } from "./frozen-documents.js";
import type { AnalysisDiagnostic, ManifestSource } from "../src/types.js";
import { checkBindingCompositions } from "../src/view-binding.js";
import { checkPassPlaces } from "../src/union-placement.js";
import { observeVaryingShapeCopyReads } from "../src/definition-registry.js";
import { isExpansionSentinel } from "@telorun/templating";
import { GENERATED, generatedCorpus, loadGenerated } from "./configuration-cost-fixtures.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `file` relative to the repository root, `/`-separated on every platform. */
const repoPath = (file: string) => relative(ROOT, file).split(sep).join("/");
const EXPECTATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/configuration-expectations.json");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

async function load(file: string) {
  const graph = await new Loader([fileSource]).loadGraph(file, { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const moduleDocuments = collectModuleDocuments(graph);
  frozenDocuments([manifests, moduleDocuments]);
  return { graph, manifests, moduleDocuments };
}

/** The analysis of `file` (or of a generated application `loaded`), once. */
const analysed = new Map<string, Promise<{ diagnostics: AnalysisDiagnostic[]; order: FindingOrder }>>();
function analyse(file: string, loaded?: Awaited<ReturnType<typeof load>>) {
  let known = analysed.get(file);
  if (!known) {
    known = (async () => {
      const { graph, manifests, moduleDocuments } = loaded ?? (await load(file));
      const positions = collectFilePositions(graph);
      const diagnostics = new StaticAnalyzer().analyze(manifests, { moduleDocuments, positions });
      return { diagnostics, order: new FindingOrder(manifests, positions) };
    })();
    analysed.set(file, known);
  }
  return known;
}

/** What the analysis reports for `file` (or for a generated application
 *  `loaded`), as the committed expectations record it. */
async function findings(file: string, loaded?: Awaited<ReturnType<typeof load>>) {
  const { diagnostics } = await analyse(file, loaded);
  return diagnostics.map((d: AnalysisDiagnostic) => {
    const data = d.data as { path?: string; filePath?: string; configurations?: unknown } | undefined;
    return {
      code: d.code,
      severity: d.severity,
      ...(data?.filePath ? { file: repoPath(data.filePath) } : {}),
      ...(data?.path !== undefined ? { path: data.path } : {}),
      message: d.message,
      ...(data?.configurations ? { configurations: data.configurations } : {}),
    };
  });
}

const TAG = /(?:^|:|-|---)\s*!(?:if|switch)\b/m;
const SKIP = new Set(["node_modules", ".telo", "dist", ".claude", ".git"]);

/** Every in-repo manifest writing a choice, and every configuration fixture. */
function corpus(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".yaml")) {
        const text = readFileSync(path, "utf8");
        const written = text
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        const fixture = /__fixtures__[\\/](?:check-run-agreement[\\/])?configurations[\\/]/.test(path);
        if (fixture || TAG.test(written)) out.add(repoPath(path));
      }
    }
  };
  for (const dir of ["tests", "modules", "examples", "starters", "blueprints"]) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  }
  return [...out].sort();
}

describe("configurations", () => {
  it("report what every in-repo choice and configuration fixture finds, labels included, as committed", async () => {
    const actual: Record<string, unknown> = {};
    // Every cover's answer, composed through a view's binding, reads the
    // configurations alone; every pass finding stands at one written place
    // wherever its part holds.
    const stop = checkBindingCompositions();
    const stopPlaces = checkPassPlaces();
    // A reach decided over the varying named shapes reads each through its
    // classes, never through a copy the registry holds.
    const copies: string[] = [];
    let reading = "";
    const stopCopies = observeVaryingShapeCopyReads((id) => copies.push(`${reading}: ${id}`));
    try {
      for (const file of corpus()) {
        reading = file;
        actual[file] = await findings(join(ROOT, file));
      }
      for (const [name, text] of generatedCorpus()) {
        reading = name;
        actual[repoPath(join(GENERATED, name))] = await findings(name, await loadGenerated(name, text));
      }
    } finally {
      stop();
      stopPlaces();
      stopCopies();
    }
    expect(copies).toEqual([]);
    if (process.env.UPDATE_CONFIGURATION_EXPECTATIONS === "1") {
      writeFileSync(EXPECTATIONS, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(EXPECTATIONS, "utf8")));
  }, 120_000);

  it("report every corpus file's findings sorted by where each is written, whatever order they were found in", async () => {
    const unsorted: string[] = [];
    const reorderable: string[] = [];
    const check = async (name: string, loaded?: Awaited<ReturnType<typeof load>>) => {
      const { diagnostics, order } = await analyse(name, loaded);
      for (let i = 1; i < diagnostics.length; i++) {
        if (order.compare(diagnostics[i - 1]!, diagnostics[i]!) > 0) {
          unsorted.push(`${name} #${i}`);
          break;
        }
      }
      // The key is total: sorting the findings reversed gives the same list.
      if (JSON.stringify(order.sort([...diagnostics].reverse())) !== JSON.stringify(diagnostics)) reorderable.push(name);
    };
    for (const file of corpus()) await check(join(ROOT, file));
    for (const [name, text] of generatedCorpus()) await check(name, await loadGenerated(name, text));
    expect(unsorted).toEqual([]);
    expect(reorderable).toEqual([]);
  }, 120_000);

  it("enumerate the product of the dimensions a choice reads, and nothing else", async () => {
    const { manifests } = await load(join(ROOT, "tests/__fixtures__/configurations/decisions.yaml"));
    const choices = readChoices(
      manifests.filter((m) => !isExpansionSentinel(m)),
      manifests.filter(isExpansionSentinel),
    );
    expect(choices.dimensions.map((d) => [d.key, d.values])).toEqual([
      ["secrets.databaseUrl.scheme", ["postgres", "sqlite"]],
      ["variables.flag", [false, true]],
      ["variables.level", [1, 2]],
    ]);
    expect(enumerateConfigurations(choices.dimensions)).toHaveLength(8);
    expect(choices.firstConfiguration).toEqual({
      "secrets.databaseUrl.scheme": "postgres",
      "variables.flag": false,
      "variables.level": 1,
    });
  });

  it("describe a set of configurations by its smallest product, omitting a dimension it holds whole", () => {
    const dimensions: Dimension[] = [
      { key: "variables.dialect", input: "variables", name: "dialect", projection: "whole", values: ["sqlite", "postgres", "mysql"], declaration: {} },
      { key: "secrets.key", input: "secrets", name: "key", projection: "presence", values: ["present", "absent"], declaration: {} },
    ];
    const all = enumerateConfigurations(dimensions);
    const pick = (test: (a: Record<string, unknown>) => boolean) => all.filter(test);
    expect(describeConfigurations(pick((a) => a["variables.dialect"] === "postgres"), all, dimensions)).toBe(
      "(when variables.dialect is postgres)",
    );
    expect(describeConfigurations(pick((a) => a["secrets.key"] === "absent"), all, dimensions)).toBe(
      "(when secrets.key is absent)",
    );
    expect(
      describeConfigurations(
        pick((a) => a["variables.dialect"] !== "mysql" && a["secrets.key"] === "present"),
        all,
        dimensions,
      ),
    ).toBe("(when variables.dialect is sqlite or postgres and secrets.key is present)");
    expect(
      describeConfigurations(
        pick(
          (a) =>
            (a["variables.dialect"] === "mysql" && a["secrets.key"] === "absent") ||
            (a["variables.dialect"] === "sqlite" && a["secrets.key"] === "present"),
        ),
        all,
        dimensions,
      ),
    ).toBe(
      "(when variables.dialect is sqlite and secrets.key is present; or when variables.dialect is mysql and secrets.key is absent)",
    );
  });

  it.each(["named-shape-schema-ref-choice", "named-shape-contract-ref-choice", "named-shape-alias-kind-choice"])(
    "report %s's findings whichever configuration is read first",
    async (name) => {
      const at = (file: string) => join(ROOT, "tests/__fixtures__/configurations", file);
      const reversed = (await findings(at(`${name}-reversed.yaml`))).map((f) => ({ ...f, file: f.file?.replace("-reversed", "") }));
      expect(reversed).toEqual(await findings(at(`${name}.yaml`)));
    },
  );

  it("key a need's presence and a member of its field by the need path the environment is read for", async () => {
    const dimensionsOf = async (file: string) => {
      const { manifests, moduleDocuments } = await load(join(ROOT, "tests/__fixtures__/configurations/needs", file));
      const options = { moduleDocuments, skipValidation: true };
      const registry = new AnalysisRegistry();
      new StaticAnalyzer().analyze(manifests, options, registry);
      const choices = readChoices(
        manifests.filter((m) => !isExpansionSentinel(m)),
        manifests.filter(isExpansionSentinel),
        choiceScopeOf(manifests, registry, [], registeredNeedTable(manifests, registry, options.moduleDocuments)),
      );
      return choices.dimensions.map((d) => [d.key, d.values]);
    };
    expect(await dimensionsOf("presence.yaml")).toEqual([["resources.a", ["present", "absent"]]]);
    expect(await dimensionsOf("scheme.yaml")).toEqual([["resources.store.url.scheme", ["mem", "file"]]]);
    expect(await dimensionsOf("orders/telo.yaml")).toEqual([["resources.databaseAccess", ["present", "absent"]]]);
    expect(await dimensionsOf("library.yaml")).toEqual([["resources.Orders.databaseAccess", ["present", "absent"]]]);
    expect(await dimensionsOf("library-supplied.yaml")).toEqual([]);
    expect(await dimensionsOf("library-forwarded.yaml")).toEqual([["resources.root", ["present", "absent"]]]);
    expect(await dimensionsOf("library-twice.yaml")).toEqual([
      ["resources.A.databaseAccess", ["present", "absent"]],
      ["resources.B.databaseAccess", ["present", "absent"]],
      ["resources.OrdersShared.databaseAccess", ["present", "absent"]],
    ]);
  });
});

describe("a template body's choice over a module input", () => {
  const fixture = (name: string) => join(ROOT, "tests/__fixtures__/configurations", name);
  /** `file`'s findings within `within`: code, message and configurations. */
  const within = async (file: string, kept: Record<string, unknown>) => {
    const { manifests, moduleDocuments } = await load(fixture(file));
    return new StaticAnalyzer()
      .analyze(manifests, { moduleDocuments, within: kept })
      .map((d) => [d.code, d.message, (d.data as { configurations?: unknown } | undefined)?.configurations]);
  };
  const BODY = "Telo.Definition/Wrapper: 'store: !ref missing' on the Kinds.Holder entry 'inner' names no sibling 'resources:' entry and no resource of this module. Siblings: store.";

  it("is the application's one configuration dimension of that input", async () => {
    const { manifests, moduleDocuments } = await load(fixture("template-body-input-choice.yaml"));
    const { union } = new StaticAnalyzer().configurationsOf(manifests, { moduleDocuments });
    expect(
      union.space.dimensions.filter((d) => d.key.endsWith("variables.x")).map((d) => [d.key, d.definition]),
    ).toEqual([["variables.x", undefined]]);
  });

  it("keeps the branch's finding exactly where 'within' takes the branch", async () => {
    expect(await within("template-body-input-choice.yaml", { "variables.x": false })).toEqual([]);
    expect(await within("template-body-input-choice.yaml", { "variables.x": true })).toEqual([
      ["TEMPLATE_REF_UNKNOWN", BODY, undefined],
    ]);
  });

  it("tells a module finding under the input's other value apart from the body's", async () => {
    expect((await within("template-body-input-correlation.yaml", { "variables.x": false })).map(([code]) => code)).toEqual([
      "UNRESOLVED_REFERENCE",
    ]);
    expect(await within("template-body-input-correlation.yaml", { "variables.x": true })).toEqual([
      ["TEMPLATE_REF_UNKNOWN", BODY, undefined],
    ]);
  });

  it("names the input and the definition's own value in one clause where they correlate", async () => {
    expect(await within("template-body-input-definition.yaml", {})).toEqual([
      [
        "TEMPLATE_REF_UNKNOWN",
        `${BODY} (when variables.x is false and self.mode is b; or when variables.x is true and self.mode is a)`,
        undefined,
      ],
    ]);
  });

  it("holds a definition's finding and a consumer's forwarded one in the same configurations", async () => {
    const found = await within("template-body-input-agreement.yaml", {});
    const forwarded = found.find(([code, message]) => code === "CEL_TYPE_ERROR" && String(message).includes("forwarded"));
    const own = found.find(([code, message]) => code === "CEL_TYPE_ERROR" && String(message).startsWith("Telo.Definition/Wrapped"));
    expect(forwarded?.[2]).toEqual([{ "variables.x": true }]);
    expect(own?.[2]).toEqual(forwarded?.[2]);
  });
});
