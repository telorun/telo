import { afterEach, expect, it } from "vitest";
import { celFieldCompletions } from "../cel-field-completion";
import { fakeEngineSpawner } from "./fake-engine";
import { fakeMonaco } from "./fake-monaco";
import { startSession, stopSessions } from "./session-harness";

afterEach(stopSessions);

it("completes a form field's CEL value from its module's engine, the edit landing in the field's model", async () => {
  const { monaco } = fakeMonaco();
  const at = { line: 0, character: 5 };
  const { spawner, received } = fakeEngineSpawner(
    { textDocumentSync: 1, experimental: { telo: { viewModel: true } } },
    { "telo/celCompletion": () => [{ label: "shout", kind: 3, textEdit: { range: { start: at, end: at }, newText: "shout" } }] },
  );
  const session = await startSession({ monaco, spawner });
  const field = monaco.editor.createModel("Self.", "telo-cel", monaco.Uri.parse("inmemory://cel/1"));

  const result = await celFieldCompletions(
    monaco,
    session,
    { modulePath: "/ws/app/telo.yaml", resource: { kind: "Work.Task", name: "main" }, path: "label", tag: "cel" },
    field,
    { lineNumber: 1, column: 6 },
  );

  expect(received.find((m) => m.method === "telo/celCompletion")?.params).toEqual({
    owner: "file:///ws/app/telo.yaml",
    resource: { kind: "Work.Task", name: "main" },
    path: "label",
    tag: "cel",
    text: "Self.",
    offset: 5,
  });
  expect(result.suggestions.map((s) => [s.label, s.insertText, s.range])).toEqual([
    ["shout", "shout", { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 }],
  ]);
});
