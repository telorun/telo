import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * `callsCoReferrers` on an `x-telo-ref`: dispatching an announce calls every
 * module-scope listener naming its topic, in the same module instance — so a
 * zone the announce runs in encloses each listener's target — and the
 * annotation's own refusals. Generic fixture kinds (`co-referrers/kinds`).
 */
const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/co-referrers");

async function findings(file: string, ...codes: string[]): Promise<string[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer()
    .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
    .filter((d) => codes.some((code) => d.code.startsWith(code)))
    .map((d) => {
      const data = d.data as { resource?: { name?: string }; path?: string } | undefined;
      return `${d.code} ${data?.resource?.name ?? "-"} ${data?.path}: ${d.message}`;
    });
}

const SHAPE =
  "It is '{ kind: <Alias>.<Kind>, slot: /<pointer> }': the kind whose declarations this dispatch " +
  "calls, and the reference slot of that kind naming this slot's target.";
const REFUSALS = [
  `Telo.Definition 'Unresolved': x-telo-ref at 'schema.properties.topic' declares 'callsCoReferrers', and its kind 'Co.Listenr' does not resolve. ${SHAPE}`,
  `Telo.Definition 'NoSlot': x-telo-ref at 'schema.properties.topic' declares 'callsCoReferrers', and 'CoKinds.Listener' declares no reference slot at '/when'. ${SHAPE}`,
  `Telo.Definition 'CannotHold': x-telo-ref at 'schema.properties.topic' declares 'callsCoReferrers', but the slot of 'CoKinds.Listener' at '/invoke' takes Telo.Executable, which cannot hold this slot's target (CoKinds.Topic). ${SHAPE}`,
  `Telo.Definition 'NotAnObject': x-telo-ref at 'schema.properties.topic' declares 'callsCoReferrers', whose value "Co.Listener" is not an object with a kind and a slot pointer. ${SHAPE}`,
];

describe("callsCoReferrers", () => {
  it("accepts a well-formed annotation", async () => {
    expect(await findings("kinds/telo.yaml", "X_TELO_REF_")).toEqual([]);
  }, 120_000);

  it("refuses each malformed form at the kind", async () => {
    const names = ["Unresolved", "NoSlot", "CannotHold", "NotAnObject"];
    expect(await findings("malformed/telo.yaml", "X_TELO_REF_")).toEqual(
      REFUSALS.map(
        (message, i) =>
          `X_TELO_REF_INVALID_CALLS_CO_REFERRERS ${names[i]} schema.properties.topic.x-telo-ref.callsCoReferrers: ${message}`,
      ),
    );
  }, 120_000);

  it("refuses an imported library's at the import reaching it", async () => {
    expect(await findings("malformed/consumer.yaml", "X_TELO_REF_")).toEqual(
      REFUSALS.map(
        (message) =>
          `X_TELO_REF_INVALID_CALLS_CO_REFERRERS - imports.Bad: Imported library 'BadCalls', reached through import 'Bad': ${message}`,
      ),
    );
  }, 120_000);

  it("proves a listener's target inside the zone its announce runs in", async () => {
    expect(await findings("zones/inside.yaml", "ZONE_")).toEqual([]);
  }, 120_000);

  it("refuses the listener's target when its topic is also announced outside the zone", async () => {
    expect(await findings("zones/outside.yaml", "ZONE_")).toEqual([
      "ZONE_REQUIREMENT_UNSATISFIED CoReferrerOutside targets[1].invoke: the inline Co.Guarded requires a CoKinds.Zone zone, and the path the inline Co.Guarded → onJoined → reannounce → CoReferrerOutside.targets[1].invoke reaches the application's boot targets, which nothing encloses. the operation would run outside the zone.",
    ]);
  }, 120_000);

  it("matches listeners per module instance of an isolated library", async () => {
    expect(await findings("instances/isolated.yaml", "ZONE_")).toEqual([
      "ZONE_REQUIREMENT_UNSATISFIED IsolatedInstances targets[1].invoke: the inline Co.Guarded requires a CoKinds.Zone zone, and the path the inline Co.Guarded → onSecondJoined → announce → relay → IsolatedInstances.targets[1].invoke reaches the application's boot targets, which nothing encloses. the operation would run outside the zone.",
    ]);
  }, 120_000);

  it("matches one instance of a shared library under every alias", async () => {
    expect(await findings("instances/shared.yaml", "ZONE_")).toEqual([
      "ZONE_REQUIREMENT_UNSATISFIED SharedInstances targets[1].invoke: the inline Co.Guarded requires a CoKinds.Zone zone, and the path the inline Co.Guarded → onFirstJoined → announce → SharedInstances.targets[1].invoke reaches the application's boot targets, which nothing encloses. the operation would run outside the zone.",
    ]);
  }, 120_000);

  it("refuses a co-referrer declared in a scope", async () => {
    const tail =
      "which makes it a co-referrer that every dispatch through a 'callsCoReferrers' slot naming Joined calls, " +
      "but it is declared in the";
    const fix = "so it exists only while that scope runs and no such dispatch can reach it; declare it at module scope.";
    expect(await findings("scoped/telo.yaml", "CO_REFERRER_")).toEqual([
      `CO_REFERRER_SCOPED announceTest with[0].topic: Co.Listener 'captureJoined' names Joined at 'topic', ${tail} \`with:\` scope of 'announceTest', ${fix}`,
      `CO_REFERRER_SCOPED held members[0].topic: Co.Listener 'heldListener' names Joined at 'topic', ${tail} \`members:\` scope of 'held', ${fix}`,
    ]);
  }, 120_000);

  it("draws each co-referrer call in the module graph, from a named and an inline declaration", async () => {
    const loaded = await loadFile(join(FIXTURES, "topology/telo.yaml"));
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }, registry);
    const root = loaded.manifests.find((m) => m.kind === "Telo.Application")!;
    const options = { root, entryModule: "CoReferrerTopology" };
    const graph = registry.analysisOf(loaded.manifests).moduleGraph(registry.moduleGraphDeps(loaded.manifests, options), options);
    const nameOf = (id: string | undefined) => graph.nodes.find((n) => n.id === id)?.name;
    expect(
      graph.edges
        .filter((e) => e.coReferrer)
        .map((e) => `${nameOf(e.from)} ${e.slot} → ${nameOf(e.to)} (${e.class})`)
        .sort(),
    ).toEqual(["announceAll steps[].invoke.topic → onJoined (flow)", "announceNamed topic → onJoined (flow)"]);
  }, 120_000);
});

describe("x-telo-context-ref-from", () => {
  it("types the binding from the shape a reference names, imported and with extends folded", async () => {
    expect(await findings("typed/telo.yaml", "CEL_")).toEqual([
      "CEL_UNKNOWN_FIELD onImported when: Co.Listener/onImported: !cel: 'event.kye' is not defined (available: userId, email)",
      "CEL_UNKNOWN_FIELD onLocal when: Co.Listener/onLocal: !cel: 'event.kye' is not defined (available: userId)",
    ]);
  }, 120_000);
});
