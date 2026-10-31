import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpansionSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { readChoices } from "../src/choice-reading.js";
import { choiceScopeOf } from "../src/choice-scope.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { inputRequirements, requirementDimensions, requirementSentence } from "../src/input-requirements.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import { registeredNeedTable } from "../src/validate-needs.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/** The requirements of `file`, with its root and need table. */
async function derive(file: string) {
  const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, file), { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const libraries = collectModuleDocuments(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, { moduleDocuments: libraries, skipValidation: true }, registry);
  const table = registeredNeedTable(manifests, registry, libraries);
  const choices = readChoices(
    manifests.filter((m) => !isExpansionSentinel(m)),
    manifests.filter(isExpansionSentinel),
    choiceScopeOf(manifests, registry, [], table),
  );
  const root = manifests.find((m) => m.kind === "Telo.Application");
  return { derived: inputRequirements(manifests, choices, table, libraries), root, table };
}

/** Each input of `file` with the configurations requiring it. */
async function requirements(file: string) {
  const { derived } = await derive(file);
  return Object.fromEntries(
    derived.inputs.map((input) => [
      `${input.block}.${input.name}`,
      input.required ? (input.requiredWhen ?? "always") : "never",
    ]),
  );
}

describe("input requirements", () => {
  it("require a secret only where the branch reading it is chosen", async () => {
    expect(await requirements("requirements/provider.yaml")).toEqual({
      "secrets.openaiApiKey": "never",
      "secrets.anthropicApiKey": [{ "secrets.openaiApiKey": "absent" }],
    });
  });

  it("require a need only where its reads and references reach it", async () => {
    expect(await requirements("needs/presence.yaml")).toEqual({
      "variables.expected": "never",
      "needs.a": "never",
      "needs.b": [{ "resources.a": "absent" }],
    });
    expect(await requirements("needs/database.yaml")).toEqual({
      "needs.databaseAccess": "never",
      "needs.data": [{ "resources.databaseAccess": "absent" }],
    });
  });

  it("decide requiredness at one configuration by whether some requiredWhen entry agrees on every key it names", async () => {
    const { derived } = await derive("requirements/provider.yaml");
    const anthropic = { block: "secrets", name: "anthropicApiKey" } as const;
    const openai = { block: "secrets", name: "openaiApiKey" } as const;
    expect(derived.requiredIn(anthropic, { "secrets.openaiApiKey": "absent" })).toBe(true);
    expect(derived.requiredIn(anthropic, { "secrets.openaiApiKey": "present" })).toBe(false);
    expect(derived.requiredIn(openai, { "secrets.openaiApiKey": "absent" })).toBe(false);
  });

  it("translate a library's requirement through its import", async () => {
    expect(await requirements("needs/notes-app.yaml")).toEqual({
      "needs.Notes.databaseAccess": "never",
      "needs.Notes.data": [{ "resources.Notes.databaseAccess": "absent" }],
    });
  });

  it("translate a library's requirement through every import level", async () => {
    expect(await requirements("needs/shelf-app.yaml")).toEqual({
      "needs.Shelf.Notes.databaseAccess": "never",
      "needs.Shelf.Notes.data": [{ "resources.Shelf.Notes.databaseAccess": "absent" }],
    });
  });

  it("translate a library's requirement through whether its import supplies a resource input", async () => {
    expect(await requirements("requirements/optional-input-app.yaml")).toEqual({
      "needs.Supplying.data": "never",
      "needs.Omitting.data": "always",
    });
  });

  it("count only the arm a decided guard takes", async () => {
    expect(await requirements("requirements/ternary.yaml")).toEqual({
      "variables.p": "never",
      "secrets.aKey": [{ "variables.p": "a" }],
      "secrets.bKey": [{ "variables.p": "b" }],
    });
  });

  it("count a kind document's reads where its kind is instantiated", async () => {
    expect(await requirements("requirements/kinds.yaml")).toEqual({
      "variables.provider": "never",
      "secrets.xKey": [{ "variables.provider": "x" }],
      "secrets.yKey": [{ "variables.provider": "y" }],
    });
  });
});

describe("the dimensions a requirement is decided over", () => {
  it("name the environment variables each one is read from", async () => {
    const { derived, root, table } = await derive("needs/database.yaml");
    expect(requirementDimensions(derived, root, table.environment)).toEqual([
      { key: "resources.databaseAccess", values: ["present", "absent"], env: ["DATABASE_URL"] },
    ]);
    const library = await derive("needs/notes-app.yaml");
    expect(requirementDimensions(library.derived, library.root, library.table.environment)).toEqual([
      {
        key: "resources.Notes.databaseAccess",
        values: ["present", "absent"],
        env: ["TELO_NEED_NOTES__DATABASE_ACCESS__URL"],
      },
    ]);
  });
});

describe("the requirement sentence", () => {
  const dimensions = [
    { key: "variables.provider", values: ["openai", "anthropic"], env: ["AI_PROVIDER"] },
    { key: "secrets.openaiApiKey", values: ["present", "absent"], env: ["OPENAI_API_KEY"] },
    { key: "resources.store", values: ["present", "absent"], env: ["STORE_URL", "STORE_TOKEN"] },
    { key: "secrets.databaseUrl.scheme", values: ["postgres", "sqlite"], env: ["DATABASE_URL"], member: "scheme" },
    { key: "variables.flag", values: [true, false], env: [] },
  ];

  it("spells each value in the environment's names, a dimension naming none by its key", () => {
    expect(requirementSentence([{ "secrets.openaiApiKey": "absent" }], dimensions)).toBe("OPENAI_API_KEY is unset");
    expect(requirementSentence([{ "secrets.openaiApiKey": "present" }], dimensions)).toBe("OPENAI_API_KEY is set");
    expect(requirementSentence([{ "resources.store": "absent" }], dimensions)).toBe(
      "none of STORE_URL, STORE_TOKEN is set",
    );
    expect(requirementSentence([{ "resources.store": "present" }], dimensions)).toBe(
      "STORE_URL, STORE_TOKEN are set",
    );
    expect(requirementSentence([{ "variables.provider": "openai" }], dimensions)).toBe("AI_PROVIDER is openai");
    expect(requirementSentence([{ "secrets.databaseUrl.scheme": "postgres" }], dimensions)).toBe(
      "the scheme of DATABASE_URL is postgres",
    );
    expect(requirementSentence([{ "variables.flag": true }], dimensions)).toBe("variables.flag is true");
  });

  it("joins conjuncts with and, alternatives with or", () => {
    expect(
      requirementSentence(
        [
          { "variables.provider": "anthropic", "secrets.openaiApiKey": "absent" },
          { "resources.store": "absent" },
        ],
        dimensions,
      ),
    ).toBe("AI_PROVIDER is anthropic and OPENAI_API_KEY is unset or none of STORE_URL, STORE_TOKEN is set");
  });
});
