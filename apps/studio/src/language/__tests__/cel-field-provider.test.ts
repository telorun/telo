import { afterEach, expect, it } from "vitest";
import { bindCelField, CEL_FIELD_LANGUAGE_ID, registerCelFieldLanguage } from "../cel-field-provider";
import { fakeEngineSpawner } from "./fake-engine";
import { fakeMonaco } from "./fake-monaco";
import { startSession, stopSessions } from "./session-harness";

afterEach(stopSessions);

it("completes a CEL field's model through the session it is bound to, and leaves an unbound model alone", async () => {
  const { monaco, providers } = fakeMonaco();
  const { spawner, received } = fakeEngineSpawner(
    { textDocumentSync: 1, experimental: { telo: { viewModel: true } } },
    { "telo/celCompletion": () => [{ label: "words" }] },
  );
  const session = await startSession({ monaco, spawner });
  registerCelFieldLanguage(monaco);
  const provider = providers.get("completion")!;
  expect(provider.selector).toBe(CEL_FIELD_LANGUAGE_ID);

  const bound = monaco.editor.createModel("resources.", CEL_FIELD_LANGUAGE_ID, monaco.Uri.parse("inmemory://cel/bound"));
  const site = { modulePath: "/ws/app/telo.yaml", resource: { kind: "Work.Task", name: "main" }, path: "label", tag: "cel" };
  bindCelField(bound.uri.toString(), { session, site });
  const unbound = monaco.editor.createModel("resources.", CEL_FIELD_LANGUAGE_ID, monaco.Uri.parse("inmemory://cel/unbound"));

  const completed = await provider.provider.provideCompletionItems(bound, { lineNumber: 1, column: 11 });
  expect(completed.suggestions.map((s: { label: string }) => s.label)).toEqual(["words"]);
  expect(received.find((m) => m.method === "telo/celCompletion")?.params).toMatchObject({
    owner: "file:///ws/app/telo.yaml",
    resource: site.resource,
    path: "label",
    tag: "cel",
  });

  expect(await provider.provider.provideCompletionItems(unbound, { lineNumber: 1, column: 11 })).toEqual({ suggestions: [] });
  bindCelField(bound.uri.toString(), undefined);
});
