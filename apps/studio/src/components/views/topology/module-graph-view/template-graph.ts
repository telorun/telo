import type { ModuleGraph } from "@telorun/analyzer";
import type { TemplateGraphData, ViewModel } from "@telorun/editor-protocol";
import type { ResourceManifest } from "@telorun/sdk";
import { moduleGraphFromData } from "../../../../language/module-graph-from-data";

/**
 * A templated kind's body, drawn as a module — see the analyzer's
 * `templateModule`. The module's engine builds the graph by the SAME projection
 * it draws the module from, against the closure's own kinds, so a box inside
 * the body and a box at top level cannot disagree about what a kind's slots are.
 */
export interface TemplateGraph {
  /** Canonical `<module>.<Name>` of the kind. */
  kindId: string;
  name: string;
  module?: string;
  /** The kind's capability, inherited along `extends` where it declares none. */
  capability?: string;
  /** The definition as analyzed — what a read-only body is read from, where
   *  the workspace holds no document to edit. */
  definition: ResourceManifest;
  graph: ModuleGraph;
}

const served = new WeakMap<TemplateGraphData, TemplateGraph>();

/** The body of the kind `kindId` as the module's view model carries it, or
 *  null when no templated definition in the module's closure declares it. */
export function templateGraphFromViewModel(model: ViewModel, kindId: string): TemplateGraph | null {
  const data = model.templates[kindId];
  if (!data) return null;
  const known = served.get(data);
  if (known) return known;
  const template: TemplateGraph = {
    kindId: data.kindId,
    name: data.name,
    ...(data.module !== undefined ? { module: data.module } : {}),
    ...(data.capability !== undefined ? { capability: data.capability } : {}),
    definition: data.definition as unknown as ResourceManifest,
    graph: moduleGraphFromData(data.graph),
  };
  served.set(data, template);
  return template;
}
