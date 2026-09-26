import { expect, it } from "vitest";
import type { ModuleDocument } from "../../model";
import { isWorkspaceWrite, WorkspaceModels } from "../workspace-models";
import { fakeMonaco } from "./fake-monaco";

const PATH = "/ws/app/telo.yaml";
const URI = "file:///ws/app/telo.yaml";
const documents = (text: string) => new Map([[PATH, { loaded: { text } } as unknown as ModuleDocument]]);

it("writes the workspace's text into each model, except over what the user has typed since", () => {
  const { monaco } = fakeMonaco();
  const models = new WorkspaceModels(monaco);
  models.sync(documents("a: 1\n"));
  const model = monaco.editor.getModel(monaco.Uri.parse(URI))!;
  expect(model.getValue()).toBe("a: 1\n");

  const writes: boolean[] = [];
  model.onDidChangeContent(() => writes.push(isWorkspaceWrite(URI)));
  models.sync(documents("a: 2\n"));
  expect(model.getValue()).toBe("a: 2\n");

  model.setValue("a: typed\n");
  models.sync(documents("a: 3\n"));
  expect(model.getValue()).toBe("a: typed\n");
  expect(writes).toEqual([true, false]);

  expect(models.sync(new Map())).toEqual([PATH]);
  expect(monaco.editor.getModel(monaco.Uri.parse(URI))).toBeNull();
});
