import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeAnalysisRuns, type AnalysisRunPurpose } from "../src/cel-site-judgements.js";
import { observeDefinitionRegistrations } from "../src/definition-registration.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { analyzeLoadedGraph } from "../src/graph-analysis.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const LIBRARY = `kind: Telo.Library
metadata: { name: Jobs }
exports: { kinds: [Job, Other] }
---
kind: Telo.Definition
metadata: { name: Job }
capability: Telo.Invocable
controllers: [pkg:npm/@telorun/fixture@0.1.0#Job]
schema: { type: object }
---
kind: Telo.Definition
metadata: { name: Other }
capability: Telo.Invocable
controllers: [pkg:npm/@telorun/fixture@0.1.0#Other]
schema: { type: object }
`;

// Three values of one choice: three configurations of the entry.
const APP = `kind: Telo.Application
metadata: { name: Choice }
imports:
  Jobs: ./jobs/telo.yaml
variables:
  dialect:
    env: DIALECT
    type: string
    enum: [alpha, beta, gamma]
    default: beta
--- !switch
metadata: { name: db }
switch: !cel "variables.dialect"
cases:
  alpha: { kind: Jobs.Job }
  beta: { kind: Jobs.Other }
  gamma: { kind: Jobs.Job }
`;

async function loadApp() {
  const url = "/app/telo.yaml";
  return new Loader([inMemorySource({ [url]: APP, "/app/jobs/telo.yaml": LIBRARY })]).loadGraph(url, {
    desugarImports: true,
  });
}

/** Registrations and configuration runs made while `body` runs. */
async function counted(body: () => unknown): Promise<{ registrations: number; configurations: number }> {
  let registrations = 0;
  const runs: AnalysisRunPurpose[] = [];
  const stopRegistrations = observeDefinitionRegistrations(() => registrations++);
  const stopRuns = observeAnalysisRuns((purpose) => runs.push(purpose));
  try {
    await body();
  } finally {
    stopRegistrations();
    stopRuns();
  }
  return { registrations, configurations: runs.filter((run) => run === "configuration").length };
}

describe("definition registration", () => {
  it("runs once per analysed root, whatever the number of configurations", async () => {
    const graph = await loadApp();
    // `telo check`: the entry and the library's own verdict, one root each.
    const check = await counted(() => analyzeLoadedGraph(graph));
    expect(check.configurations).toBeGreaterThanOrEqual(3);
    expect(check.registrations).toBe(2);
    // A flattened set alone, validated and on a warm load.
    const manifests = flattenForAnalyzer(graph);
    const moduleDocuments = collectModuleDocuments(graph);
    for (const skipValidation of [false, true]) {
      const flat = await counted(() =>
        new StaticAnalyzer().analyze(manifests, { moduleDocuments, skipValidation }, new AnalysisRegistry()),
      );
      expect(flat.registrations).toBe(1);
    }
  });
});
