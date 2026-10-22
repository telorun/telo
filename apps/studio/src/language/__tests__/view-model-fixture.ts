import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type ManifestSource,
} from "@telorun/analyzer";
import type { ViewModel } from "@telorun/editor-protocol";
import { buildViewModel } from "@telorun/ide-support";
import { loadWorkspace } from "../../loader";
import { LocalStorageAdapter } from "../../loader/adapters/local-storage";
import { buildModuleViewData } from "../../view-data";

export const APP = "/ws/app/telo.yaml";

/** An application importing a library of three kinds: a task holding a
 *  reference to another task and to invocables whose output must carry a
 *  `count` — one of them spelling a value type the legacy way the engine
 *  migrates — a source returning no `count`, and a counter returning one; and
 *  a templated kind whose body declares a counter under a module resource's
 *  name and a source of its own. */
const FILES: Record<string, string> = {
  [APP]: `kind: Telo.Application
metadata:
  name: Shop
imports:
  Work: ../jobs
targets:
  - !ref main
---
kind: Work.Source
metadata:
  name: words
value: hello
---
kind: Work.Count
metadata:
  name: counter
---
kind: Work.Task
metadata:
  name: main
label: !cel "resources.words.value"
next: !ref tail
source: !ref words
---
kind: Work.Task
metadata:
  name: tail
next: !ref tail
---
kind: Telo.Definition
metadata:
  name: Pipeline
capability: Telo.Runnable
schema:
  type: object
resources:
  - kind: Work.Task
    metadata:
      name: first
    next: !ref second
  - kind: Work.Task
    metadata:
      name: second
  - kind: Work.Count
    metadata:
      name: words
  - kind: Work.Source
    metadata:
      name: src
    value: x
run: !ref first
`,
  "/ws/jobs/telo.yaml": `kind: Telo.Library
metadata:
  name: Jobs
  version: 1.0.0
exports:
  kinds: [Task, Source, Count]
---
kind: Telo.Definition
metadata:
  name: Source
capability: Telo.Invocable
inputType:
  type: object
  properties:
    prefix: { type: string }
outputType:
  type: object
  required: [value]
  properties:
    value: { type: string }
schema:
  type: object
  properties:
    value: { type: string }
---
kind: Telo.Definition
metadata:
  name: Count
capability: Telo.Invocable
outputType:
  type: object
  required: [count]
  properties:
    count: { type: integer }
schema:
  type: object
---
kind: Telo.Definition
metadata:
  name: Task
capability: Telo.Runnable
schema:
  type: object
  properties:
    label:
      type: string
      x-telo-eval: compile
    next:
      x-telo-ref: { kind: Self.Task, use: call }
    source:
      x-telo-ref:
        kind: Telo.Invocable
        use: call
        outputType:
          type: object
          required: [count]
          properties:
            count: { type: integer }
    sink:
      x-telo-ref:
        kind: Telo.Invocable
        use: call
        outputType:
          type: object
          required: [count]
          properties:
            count: { type: integer }
            port: { x-telo-type: TcpPort }
`,
};

const source: ManifestSource = {
  supports: (url) => url.startsWith("/"),
  async read(url) {
    const path = url.endsWith(".yaml") ? url : `${url}/telo.yaml`;
    const text = FILES[path];
    if (text === undefined) throw new Error(`no file ${path}`);
    return { text, source: path };
  },
  resolveRelative(base, relative) {
    const parts = base.split("/").slice(0, -1);
    for (const part of relative.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    return parts.join("/");
  },
  async entryAt(base, relative) {
    return this.resolveRelative(base, relative) in FILES ? "file" : undefined;
  },
};

/** The application analysed in process as an engine analyses it, and the
 *  view model an engine would serve for it, carried as JSON. */
export async function analysedApp() {
  const graph = await new Loader([source]).loadGraph(APP, { desugarImports: true, migrate: true });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) }, registry);
  const analysis = registry.analysisOf(manifests);
  const built = buildViewModel({
    owner: `file://${APP}`,
    revision: 1,
    graph,
    registry,
    analysis,
    uriOfSource: (path) => `file://${path}`,
    documents: { [`file://${APP}`]: 1 },
  });
  const model = JSON.parse(JSON.stringify(built)) as ViewModel;
  return { graph, manifests, registry, analysis, model };
}

/** The application's kinds as studio itself reads them from the workspace —
 *  the schemas its forms read reference slots from. */
export async function studioKinds() {
  const adapter = new LocalStorageAdapter("/ws");
  for (const [path, text] of Object.entries(FILES)) await adapter.writeFile(path, text);
  const workspace = await loadWorkspace("/ws", adapter, adapter);
  return buildModuleViewData(workspace, workspace.modules.get(APP)!).kinds;
}
