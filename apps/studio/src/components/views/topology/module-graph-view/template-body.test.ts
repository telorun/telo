import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { rebuildManifestFromDocuments, setResourceFields } from "../../../../loader";
import type { ParsedManifest, ParsedResource, Workspace } from "../../../../model";
import { parseModuleDocument } from "../../../../yaml-document";
import { withBootTarget } from "../boot-targets";
import {
  entryAddress,
  entryAt,
  entryPointer,
  entryRefWrites,
  templateBody,
  TemplateWriteRefused,
  withBootSequence,
  withCreatedEntries,
  withEntryFields,
} from "./template-body";

const PATH = "/ws/blue/telo.yaml";

const LIBRARY = [
  "kind: Telo.Library",
  "metadata:",
  "  name: Blue",
  "---",
  "kind: Telo.Definition",
  "metadata:",
  "  name: App",
  "capability: Telo.Runnable",
  "resources:",
  "  # the poller",
  "  - kind: Self.Poller",
  "    metadata: { name: poller }",
  "    job: !ref job",
  "  - kind: Self.Job",
  "    metadata: { name: job }",
  "run: !ref poller",
  "",
].join("\n");

function libraryWorkspace(text: string): Workspace {
  const manifest: ParsedManifest = {
    filePath: PATH,
    kind: "Library",
    metadata: { name: "Blue" },
    imports: [],
    resources: [],
  };
  return rebuildManifestFromDocuments(
    {
      rootDir: "/ws",
      modules: new Map([[PATH, manifest]]),
      importGraph: new Map(),
      importedBy: new Map(),
      documents: new Map([[PATH, parseModuleDocument(PATH, text)]]),
      resourceDocIndex: new Map(),
    },
    PATH,
  );
}

const definitionOf = (workspace: Workspace): ParsedResource =>
  workspace.modules.get(PATH)!.resources.find((r) => r.kind === "Telo.Definition")!;
const textOf = (workspace: Workspace) =>
  workspace.documents.get(PATH)!.loaded.documents[1].toString();
const ref = (name: string) => makeTaggedSentinel("ref", name);

describe("a template body's boot sequence", () => {
  it("reads a lone `run:` as one entry, and writes a second one as `targets:` in its place", () => {
    const workspace = libraryWorkspace(LIBRARY);
    const definition = definitionOf(workspace);
    const body = templateBody(definition);
    expect(body.bootRoot.fields.targets).toEqual([ref("poller")]);

    const next = withBootSequence(body, withBootTarget(body.bootRoot.fields.targets, "job"));
    const written = setResourceFields(workspace, PATH, "Telo.Definition", "App", definition.fields, next);
    expect(textOf(written)).not.toContain("run:");
    expect(textOf(written)).toMatch(/targets:\n {2}- !ref poller\n {2}- !ref job\n$/);

    expect(withBootSequence(body, [])).not.toHaveProperty("run");
    expect(withBootSequence(body, [])).not.toHaveProperty("targets");
  });
});

describe("an edit to a template entry", () => {
  const body = templateBody(definitionOf(libraryWorkspace(LIBRARY)));

  it("lands at the entry's place in `resources:`, keeping its kind and name", () => {
    expect(body.entries.map((e) => [e.kind, e.name])).toEqual([
      ["Self.Poller", "poller"],
      ["Self.Job", "job"],
    ]);
    const next = withEntryFields(body, entryAddress(body, "poller"), {
      job: ref("job"),
      interval: "1s",
    });
    expect((next.resources as unknown[])[0]).toEqual({
      kind: "Self.Poller",
      metadata: { name: "poller" },
      job: ref("job"),
      interval: "1s",
    });
    expect(entryPointer(entryAddress(body, "job"), "/steps/0")).toBe("/resources/1/steps/0");
    expect(entryAt(body, "/resources/1/steps/0")).toEqual({ kind: "Self.Job", name: "job" });
    expect(
      entryRefWrites(body, [
        { source: { kind: "Self.Poller", name: "poller" }, concretePath: "job", target: null },
      ]),
    ).toEqual([
      { source: { kind: "Telo.Definition", name: "App" }, concretePath: "resources[0].job", target: null },
    ]);
  });

  it("lands an extracted entry's writes where its declaration is written", () => {
    const inline = templateBody(
      definitionOf(
        libraryWorkspace(
          LIBRARY.replace("    job: !ref job\n", "    job:\n      kind: Self.Job\n      retries: 1\n"),
        ),
      ),
      [{ name: "poller_job", parent: "poller", site: "job" }],
    );
    expect(inline.entries.find((e) => e.name === "poller_job")).toEqual({
      kind: "Self.Job",
      name: "poller_job",
      fields: { retries: 1 },
    });
    const address = entryAddress(inline, "poller_job");
    expect(entryPointer(address, "/retries")).toBe("/resources/0/job/retries");
    expect((withEntryFields(inline, address, { retries: 2 }).resources as unknown[])[0]).toEqual({
      kind: "Self.Poller",
      metadata: { name: "poller" },
      job: { kind: "Self.Job", retries: 2 },
    });
    expect(
      entryRefWrites(inline, [
        { source: { kind: "Self.Job", name: "poller_job" }, concretePath: "next", target: "job" },
      ])[0]!.concretePath,
    ).toBe("resources[0].job.next");
  });

  it("refuses a write to a name the body declares twice, naming both places", () => {
    const twice = templateBody(
      definitionOf(
        libraryWorkspace(
          LIBRARY.replace("  - kind: Self.Job\n    metadata: { name: job }\n", [
            "  - kind: Self.Job",
            "    metadata: { name: job }",
            "  - kind: Self.Poller",
            "    metadata: { name: job }",
            "",
          ].join("\n")),
        ),
      ),
    );
    const write = () =>
      entryRefWrites(twice, [
        { source: { kind: "Self.Poller", name: "job" }, concretePath: "job", target: null },
      ]);
    expect(write).toThrow(TemplateWriteRefused);
    expect(write).toThrow("'job' names 2 entries of 'App' (resources[1], resources[2])");
    expect(() => entryAddress(twice, "job")).toThrow(TemplateWriteRefused);
  });

  it("creates what a slot asks for as a sibling entry, in the same write", () => {
    const next = withCreatedEntries(
      body,
      [{ source: { kind: "Self.Poller", name: "poller" }, concretePath: "job", target: null, createKind: "Self.Job" }],
      (kind, taken) => (taken.includes("job") ? "job2" : "job"),
    );
    expect(next.resources).toEqual([
      { kind: "Self.Poller", metadata: { name: "poller" }, job: ref("job2") },
      { kind: "Self.Job", metadata: { name: "job" } },
      { kind: "Self.Job", metadata: { name: "job2" } },
    ]);
  });
});
