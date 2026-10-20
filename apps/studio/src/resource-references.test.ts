import type { ViewModel } from "@telorun/editor-protocol";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { writeConcretePath } from "./lib/concrete-path";
import type { ApplicationManifest } from "./model";
import { analysedApp } from "./language/__tests__/view-model-fixture";
import { findViewModelReferences, knownReferences, referenceSlotsToClear } from "./resource-references";

const cel = (source: string) => makeTaggedSentinel("cel", source);

/** A module whose engine found no reference sites, so only its CEL reads
 *  name anything. */
const noSites: ViewModel = {
  owner: "file:///app/telo.yaml",
  revision: 1,
  moduleGraph: null,
  moduleRootSchema: null,
  kindSpellings: {},
  refConstraints: {},
  contracts: {},
  outputRefusals: [],
  templates: {},
  referenceSites: [],
  documents: { "file:///app/telo.yaml": 1 },
};

function manifestOf(resources: ApplicationManifest["resources"]): ApplicationManifest {
  return { kind: "Application", filePath: "/app/telo.yaml", metadata: { name: "app" }, imports: [], targets: [], resources };
}

describe("CEL reads", () => {
  it("finds a CEL read, which is the only way a provider is usually reached", () => {
    const manifest = manifestOf([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: { sql: cel("'select from ' + resources.db.schema") } },
    ]);
    expect(findViewModelReferences(noSites, manifest, "db")).toEqual([
      { via: "cel", source: { kind: "demo.Query", name: "listUsers" }, path: "sql" },
    ]);
  });

  it("ignores a resource's own reads of itself", () => {
    // The field holding it goes away with the resource being deleted, so
    // reporting it would say "delete this before deleting this".
    const manifest = manifestOf([{ kind: "demo.Query", name: "loop", fields: { sql: cel("resources.loop.sql") } }]);
    expect(findViewModelReferences(noSites, manifest, "loop")).toEqual([]);
  });

  it("does not read a name out of a string literal", () => {
    // Parsed, not matched as text: refusing a delete over a quoted word would
    // be a wall with no way through.
    const manifest = manifestOf([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: { sql: cel("'resources.db'") } },
    ]);
    expect(findViewModelReferences(noSites, manifest, "db")).toEqual([]);
  });

  it("skips an expression that does not parse rather than failing the check", () => {
    const manifest = manifestOf([
      { kind: "demo.Conn", name: "db", fields: {} },
      { kind: "demo.Query", name: "listUsers", fields: { sql: cel("resources.db +") } },
    ]);
    expect(findViewModelReferences(noSites, manifest, "db")).toEqual([]);
  });
});

describe("findViewModelReferences", () => {
  /** The fixture application as studio parses it — the half CEL reads come
   *  from; its reference slots come from the view model. */
  const manifest: ApplicationManifest = {
    kind: "Application",
    filePath: "/ws/app/telo.yaml",
    metadata: { name: "Shop" },
    imports: [],
    targets: [],
    resources: [
      { kind: "Work.Source", name: "words", fields: { value: "hello" } },
      { kind: "Work.Task", name: "main", fields: { label: cel("resources.words.value") } },
      { kind: "Work.Task", name: "tail", fields: {} },
    ],
  };

  it("finds the reference sites the engine reports and the CEL reads the module writes", async () => {
    const { model } = await analysedApp();
    expect(findViewModelReferences(model, manifest, "words")).toEqual([
      { via: "ref", source: { kind: "Work.Task", name: "main" }, path: "source" },
      { via: "cel", source: { kind: "Work.Task", name: "main" }, path: "label" },
    ]);
  });

  it("leaves out a site the named resource writes itself", async () => {
    const { model } = await analysedApp();
    expect(findViewModelReferences(model, manifest, "tail")).toEqual([
      { via: "ref", source: { kind: "Work.Task", name: "main" }, path: "next" },
    ]);
  });
});

describe("referenceSlotsToClear", () => {
  const ref = (name: string) => makeTaggedSentinel("ref", name);
  const app = (targets: unknown[], names: string[]): ApplicationManifest => ({
    ...manifestOf(names.map((name) => ({ kind: "demo.Job", name, fields: {} }))),
    targets: targets as ApplicationManifest["targets"],
  });
  /** The engine's last analysis: the boot list as it was before either delete. */
  const analysed: ViewModel = {
    ...noSites,
    referenceSites: ["x", "y", "z"].map((target, i) => ({
      source: { kind: "Telo.Application", name: "app" },
      path: `targets[${i}]`,
      target,
    })),
  };

  it("clears only a site whose live value still names the deleted resource", () => {
    // Deleting x clears its boot target, splicing the list to [y, z].
    const afterX = app([ref("x"), ref("y"), ref("z")], ["y", "z"]);
    const cleared = referenceSlotsToClear(analysed, afterX, "x");
    expect(cleared.map((r) => r.path)).toEqual(["targets[0]"]);
    const targets = { targets: [...afterX.targets] };
    writeConcretePath(targets, cleared[0]!.path, null);
    expect(targets.targets).toEqual([ref("y"), ref("z")]);

    // Deleting y before the engine catches up: its stale site targets[1] now
    // holds z, which must survive; y's own reference is left for the engine
    // to report as dangling.
    expect(referenceSlotsToClear(analysed, app(targets.targets, ["z"]), "y")).toEqual([]);
  });
});

describe("knownReferences", () => {
  const manifest = manifestOf([{ kind: "demo.Conn", name: "db", fields: {} }]);
  const ready = { state: "ready" as const, model: noSites };

  it("knows nothing from a model computed before the latest edit", () => {
    expect(knownReferences(ready, () => false, manifest, "db")).toEqual({ known: false });
  });

  it("answers from a model computed from the text the editor holds", () => {
    expect(knownReferences(ready, () => true, manifest, "db")).toEqual({ known: true, references: [] });
  });
});
