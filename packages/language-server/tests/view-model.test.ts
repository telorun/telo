import { buildViewModel, celCompletionAt } from "@telorun/ide-support";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES, HarnessHost, canonical, uri } from "./harness.js";
import { analyseInProcess } from "./in-process.js";

const OWNER = join(FIXTURES, "billing", "telo.yaml");

function revisions(host: HarnessHost): number[] {
  return host.notifications
    .filter((n) => n.method === "telo/viewModelChanged" && n.params.owner === canonical(OWNER))
    .map((n) => n.params.revision);
}

async function opened(): Promise<HarnessHost> {
  const host = new HarnessHost();
  await host.start();
  host.open(OWNER);
  await host.until(() => revisions(host).length > 0, "telo/viewModelChanged");
  return host;
}

// A structured editor holds the model the engine of the module's telo version
// computes, so it must be exactly what ide-support builds over that analysis.
it("serves an owner's view model as ide-support builds it in process", async () => {
  const host = await opened();
  const served = await host.request("telo/viewModel", { owner: canonical(OWNER) });
  const { graph, registry, analysis } = await analyseInProcess(OWNER);
  const expected = buildViewModel({
    owner: canonical(OWNER),
    revision: revisions(host).at(-1)!,
    graph,
    registry,
    analysis,
    uriOfSource: canonical,
    documents: { [canonical(OWNER)]: 1 },
  });
  expect(served).toEqual(JSON.parse(JSON.stringify(expected)));
});

// A host acting on a model's paths needs to know which text it was computed from.
it("names the version of each open document the analysis read", async () => {
  const host = await opened();
  expect((await host.request("telo/viewModel", { owner: canonical(OWNER) })).documents).toEqual({
    [canonical(OWNER)]: 1,
  });
  host.change(OWNER, `${readFileSync(OWNER, "utf8")}\n`);
  await host.until(() => revisions(host).length > 1, "a second telo/viewModelChanged");
  expect((await host.request("telo/viewModel", { owner: canonical(OWNER) })).documents).toEqual({
    [canonical(OWNER)]: 2,
  });
});

// A host re-asks when the revision moves, and learns the owner is gone the same way.
it("bumps the revision on each analysis and answers null once the owner is dropped", async () => {
  const host = await opened();
  const [first] = revisions(host);
  host.change(OWNER, `${readFileSync(OWNER, "utf8")}\n`);
  await host.until(() => revisions(host).length > 1, "a second telo/viewModelChanged");
  const second = revisions(host)[1]!;
  expect(second).toBeGreaterThan(first!);
  expect((await host.request("telo/viewModel", { owner: canonical(OWNER) })).revision).toBe(second);

  // Closed under the URI it was opened with, as LSP requires.
  host.notify("textDocument/didClose", { textDocument: { uri: uri(OWNER) } });
  await host.until(() => revisions(host).length > 2, "telo/viewModelChanged for the dropped owner");
  expect(revisions(host)[2]).toBeGreaterThan(second);
  expect(await host.request("telo/viewModel", { owner: canonical(OWNER) })).toBeNull();
});

it("answers nothing for an owner it does not analyse", async () => {
  const host = await opened();
  const other = canonical(join(FIXTURES, "ledger", "telo.yaml"));
  expect(await host.request("telo/viewModel", { owner: other })).toBeNull();
  expect(
    await host.request("telo/celCompletion", {
      owner: other,
      resource: { kind: "Ledger.Entry", name: "charge" },
      path: "amount",
      tag: "cel",
      text: "Self.",
      offset: 5,
    }),
  ).toEqual([]);
});

// A form field's value is not document text, so it is addressed by resource
// and path; the items are the ones completion inside the document would offer.
it("completes a CEL value typed into a form field", async () => {
  const host = await opened();
  const request = {
    resource: { kind: "Ledger.Entry", name: "charge" },
    path: "amount",
    tag: "cel",
    text: "Self.",
    offset: 5,
  };
  const items = await host.request("telo/celCompletion", { owner: canonical(OWNER), ...request });
  const { analysis } = await analyseInProcess(OWNER);
  const labels = items.map((i: { label: string }) => i.label);
  expect(labels).toEqual(celCompletionAt(analysis, request).map((r) => r.label));
  expect(labels).toContain("withVat");
});
