import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { NOT_AN_INPUT, resourceInputBinding } from "../src/resource-input-binding.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * A zone a library opens on a connection it was lent as a resource input
 * correlates on the declaration its importer supplied, per instance — so a
 * requirement keyed on that declaration is discharged there, and on no other.
 * Generic fixture kinds (`zone-resource-inputs/kinds`).
 */
const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/zone-resource-inputs");

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

describe("zones opened on a library resource input", () => {
  it("discharges a requirement on the lent declaration, reached through the announce", async () => {
    expect(await zoneFindings("inside.yaml")).toEqual([]);
  }, 120_000);

  it("refuses the same requirement reached outside the library's transaction", async () => {
    expect(await zoneFindings("outside.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LentOutside targets[1].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path the inline Z.Op → onCreated → reannounce → LentOutside.targets[1].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("refuses a requirement on another declaration than the one lent", async () => {
    expect(await zoneFindings("other.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LentOther targets[0].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'other', and the path the inline Z.Op → onCreated → the inline Co.Announce → create → LentOther.targets[0].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("discharges in each isolated instance only what that instance was lent", async () => {
    expect(await zoneFindings("isolated.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LentIsolated targets[0].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'secondDb', and the path the inline Z.Op → onFirstCrossed → announce → create → runFirst → LentIsolated.targets[0].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("discharges nothing on an optional input left unlent", async () => {
    expect(await zoneFindings("absent.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LentAbsent targets[0].invoke: the inline Z.Op requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path the inline Z.Op → onCreated → the inline Co.Announce → create → LentAbsent.targets[0].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("holds an exported requirement on an input to the importer's transaction on what it lent", async () => {
    expect(await zoneFindings("direct.yaml")).toEqual([
      `ZONE_REQUIREMENT_UNSATISFIED LentDirect targets[1].invoke: Z.Op 'op' requires a ZoneKinds.Tx zone on Z.Conn 'db', and the path op → onOther → LentDirect.targets[1].invoke reaches the application's boot targets, which nothing encloses. ${REASON}`,
    ]);
  }, 120_000);

  it("leaves an exported requirement on an input satisfiable at the library", async () => {
    expect(await zoneFindings("lib/telo.yaml")).toEqual([]);
  }, 120_000);
});

describe("resourceInputBinding", () => {
  const ref = (name: string) => makeTaggedSentinel("ref", name);
  const imported = (alias: string, module: string, target: string, resources: Record<string, unknown>, inputs: string[]) =>
    ({
      kind: "Telo.Import",
      metadata: {
        name: alias,
        module,
        resolvedModuleName: target,
        requiredResources: Object.fromEntries(inputs.map((input) => [input, "sql.Connection"])),
      },
      resources,
    }) as unknown as ResourceManifest;

  it("follows a library forwarding its own input to the library it imports", () => {
    const db = { kind: "sql.Connection", metadata: { name: "db", module: "App" } };
    const binding = resourceInputBinding(
      [
        imported("Outer", "App", "Outer", { connection: ref("db") }, ["connection"]),
        imported("Inner", "Outer", "Inner", { conn: ref("connection") }, ["conn"]),
      ],
      { inModule: (name, module) => (name === "db" && module === "App" ? db : undefined) },
      new AliasResolver(),
      new Map(),
    );
    expect(binding.bound("conn", "Inner", ["Outer", "Inner"])).toBe(db);
    expect(binding.bound("db", "App", undefined)).toBe(NOT_AN_INPUT);
  });
});
