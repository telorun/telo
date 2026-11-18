import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeDependencyParity, type DependencyParityReport } from "../src/cel-site-judgements.js";
import { generatedCorpus, loadGenerated, SWEPT_CHOICES } from "./configuration-cost-fixtures.js";
import { fileCorpus, loadFile, ROOT } from "./configuration-corpus.js";

/**
 * The call graph over every configuration, held at each configuration, is
 * that configuration's own: every edge — its resource, site, target and use —
 * and its boot order — every node in order and what each depends on in order,
 * every scope's members and what each holds of its siblings — equal what its
 * run builds from its own expansion.
 */
async function parity(loaded: Awaited<ReturnType<typeof loadFile>>): Promise<DependencyParityReport[]> {
  const reports: DependencyParityReport[] = [];
  const stop = observeDependencyParity((report) => reports.push(report));
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return reports;
}

const expectParity = (reports: readonly DependencyParityReport[]) => {
  for (const report of reports) {
    expect(report.lifted, `boot order at ${report.assignment}`).toEqual(report.run);
    expect(report.edges.lifted, `edges at ${report.assignment}`).toEqual(report.edges.run);
    expect(report.incoming.lifted, `incoming edges at ${report.assignment}`).toEqual(report.incoming.run);
  }
};

describe("the call graph over every configuration holds each configuration's boot order", () => {
  for (const file of fileCorpus()) {
    it(file, async () => expectParity(await parity(await loadFile(join(ROOT, file)))), 120_000);
  }
  for (const [name, text] of generatedCorpus(SWEPT_CHOICES)) {
    it(`generated ${name}`, async () => expectParity(await parity(await loadGenerated(name, text))), 120_000);
  }
});
