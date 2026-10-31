import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { readChoices } from "../src/choice-reading.js";
import { choiceScopeOf } from "../src/choice-scope.js";
import { registeredNeedTable } from "../src/validate-needs.js";
import { describeConfigurations, enumerateConfigurations, type Dimension } from "../src/configuration-dimensions.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { AnalysisDiagnostic, ManifestSource } from "../src/types.js";
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
  return { graph, manifests: flattenForAnalyzer(graph) };
}

/** What the analysis reports for `file` (or for a generated application
 *  `loaded`), as the committed expectations record it. */
async function findings(file: string, loaded?: Awaited<ReturnType<typeof load>>) {
  const { graph, manifests } = loaded ?? (await load(file));
  const diagnostics = new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) });
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
    for (const file of corpus()) actual[file] = await findings(join(ROOT, file));
    for (const [name, text] of generatedCorpus()) {
      actual[repoPath(join(GENERATED, name))] = await findings(name, await loadGenerated(name, text));
    }
    if (process.env.UPDATE_CONFIGURATION_EXPECTATIONS === "1") {
      writeFileSync(EXPECTATIONS, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(EXPECTATIONS, "utf8")));
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
    expect(choices.configurations).toHaveLength(8);
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

  it("key a need's presence and a member of its field by the need path the environment is read for", async () => {
    const dimensionsOf = async (file: string) => {
      const { graph, manifests } = await load(join(ROOT, "tests/__fixtures__/configurations/needs", file));
      const options = { moduleDocuments: collectModuleDocuments(graph), skipValidation: true };
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
