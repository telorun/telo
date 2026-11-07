import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { CallGraph, ResourceGraphNode } from "../src/call-graph.js";
import { importPathOf } from "../src/scoped-name-resolver.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * The `callsCoReferrers` fan-out is closed-world at the assembly root: an
 * importer's check holds each library's co-referrers, holders and the paths
 * reaching them, seeds a library co-referrer's requirements from that library's
 * own summary, and reports a finding where the reader can act on it. Generic
 * fixture kinds (`co-referrers/kinds`, `zone-resource-inputs/kinds`).
 */
const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/co-referrer-fan-out");

async function zoneFindings(file: string): Promise<string[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer()
    .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
    .filter((d) => d.code.startsWith("ZONE_"))
    .map((d) => {
      const data = d.data as { resource?: { name?: string }; path?: string } | undefined;
      return `${d.code} ${data?.resource?.name ?? "-"} ${data?.path}: ${d.message}`;
    });
}

const REASON = "the operation would run outside the transaction.";

describe("the co-referrer fan-out at the assembly root", () => {
  it("gives each instance of a library imported twice its own stand-ins, reached from its own emit", async () => {
    const loaded = await loadFile(join(FIXTURES, "twice/telo.yaml"));
    const registry = new AnalysisRegistry();
    const analyzer = new StaticAnalyzer();
    analyzer.analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }, registry);
    const manifests = analyzer.normalize(loaded.manifests, registry);
    const graph = (registry.analysisOf(manifests) as unknown as { callGraph: CallGraph }).callGraph;
    const shown = (id: string): string => {
      const node = graph.nodes.get(id) as ResourceGraphNode;
      return `${importPathOf(node.manifest)?.join(".")}.${node.name}`;
    };
    expect(
      graph.edges.filter((edge) => edge.coReferrer).map((edge) => `${shown(edge.from)} → ${shown(edge.to!)}`),
    ).toEqual(["First.announce → First.own", "Second.announce → Second.own"]);
  }, 120_000);

  it("proves an emit from a library's internal resource inside the transaction its export opens", async () => {
    expect(await zoneFindings("internal-emit/inside.yaml")).toEqual([]);
  }, 120_000);

  it("refuses the same emit when the export opens no transaction", async () => {
    expect(await zoneFindings("internal-emit/outside.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED InternalEmitOutside targets[0].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path the inline Z.Op → onCreated → announce → create → InternalEmitOutside.targets[0].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("reports a library's handler at the importer's emit outside the transaction", async () => {
    expect(await zoneFindings("library-handler/outside.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LibraryHandlerOutside targets[0].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path the inline Z.Op → audit → emitCreated → LibraryHandlerOutside.targets[0].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("proves a library's handler inside the importer's transaction on what it lent", async () => {
    expect(await zoneFindings("library-handler/inside.yaml")).toEqual([]);
  }, 120_000);

  it("reports a defect wholly inside one library once, at that library's own check", async () => {
    expect(await zoneFindings("wholly-inside/lib/telo.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED run body: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'conn', and the path the inline Z.Op → onDone → announce → run.body detaches there — the runtime guarantees the detached work a fresh context, outside every zone its caller was in. ${REASON}`,
    ]);
    expect(await zoneFindings("wholly-inside/telo.yaml")).toEqual([]);
  }, 120_000);

  it("reports at the importer what only its composition of two libraries makes", async () => {
    expect(await zoneFindings("composed/telo.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED - imports.Audit: Imported library 'ComposedAudit', reached through import 'Audit': the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path the inline Z.Op → audit → announce → relay.body detaches there — the runtime guarantees the detached work a fresh context, outside every zone its caller was in. ${REASON}`,
    ]);
    expect(await zoneFindings("composed/audit/telo.yaml")).toEqual([]);
    expect(await zoneFindings("composed/relay/telo.yaml")).toEqual([]);
  }, 120_000);
});
