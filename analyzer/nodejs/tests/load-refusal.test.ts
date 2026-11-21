import { describe, expect, it } from "vitest";
import { loadRefusal } from "../src/load-refusal.js";
import { Loader } from "../src/manifest-loader.js";
import type { NeedTable } from "../src/need-table.js";
import { ManifestSourceFailure } from "../src/sources/source-failure.js";
import { DiagnosticSeverity, type AnalysisDiagnostic, type ManifestSource } from "../src/types.js";
import { NEED_TABLE_MARK } from "../src/validate-needs.js";

const ENTRY = "/ws/telo.yaml";

function memorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new ManifestSourceFailure("not-found", `file://${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const EMPTY_TABLE: NeedTable = { entries: [], problems: [], environment: [], applications: [] };

describe("loadRefusal", () => {
  it("raises a need refusal holding in some configurations only under the code of an unconditional one", async () => {
    const graph = await new Loader([memorySource({ [ENTRY]: "kind: Telo.Application\nmetadata: { name: App }\n" })]).loadGraph(
      ENTRY,
      { desugarImports: true },
    );
    const collision: AnalysisDiagnostic = {
      severity: DiagnosticSeverity.Error,
      code: "DUPLICATE_RESOURCE_NAME",
      message: "Need 'a' collides with resource 'a' declared in module 'App'.",
      data: {
        filePath: ENTRY,
        path: "needs.a",
        resource: { kind: "Telo.Application", name: "App" },
        configurations: [{ "variables.pick": true }],
        [NEED_TABLE_MARK]: true,
      },
    };
    const refusal = await loadRefusal(graph, ENTRY, {
      buildModuleArtifacts: () => {},
      register: () => ({ manifests: [], rootModuleDocument: undefined }),
      analyze: () => [collision],
      needTable: () => EMPTY_TABLE,
    });
    expect(refusal).toEqual({
      code: "ERR_DUPLICATE_RESOURCE",
      message: `${ENTRY}: Need 'a' collides with resource 'a' declared in module 'App'. (ERR_DUPLICATE_RESOURCE)`,
      carried: [
        {
          need: {
            runtimeCode: "ERR_DUPLICATE_RESOURCE",
            message: "Need 'a' collides with resource 'a' declared in module 'App'.",
            path: "needs.a",
            filePath: ENTRY,
            resource: { kind: "Telo.Application", name: "App" },
          },
        },
      ],
    });
  });
});
