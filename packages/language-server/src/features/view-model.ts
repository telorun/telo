import {
  TeloMethod,
  type CelCompletionParams,
  type CelCompletionResult,
  type ViewModel,
  type ViewModelParams,
  type ViewModelResult,
} from "@telorun/editor-protocol";
import { buildViewModel, celCompletionAt } from "@telorun/ide-support";
import { canonicalDocumentUri, uriOfSource } from "../document-uri.js";
import type { OwnerAnalysis } from "../workspace-session.js";
import { toCompletionItem } from "./completion.js";
import type { FeatureContext } from "./context.js";

/**
 * The structured-view requests: an owner's view model, built on request from
 * its stored analysis and kept until that analysis is replaced, and completion
 * for a CEL value typed into a form field.
 */
export function registerViewModel({ connection, session }: FeatureContext): void {
  // One model per analysis and picked configuration.
  const built = new WeakMap<OwnerAnalysis, Map<string, ViewModel>>();

  connection.onRequest(TeloMethod.viewModel, (params: ViewModelParams): ViewModelResult => {
    const owned = session.ownerAnalysis(params.owner);
    if (!owned) return null;
    const key = JSON.stringify(
      Object.entries(params.configuration ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const models = built.get(owned.state) ?? new Map<string, ViewModel>();
    built.set(owned.state, models);
    let model = models.get(key);
    if (!model) {
      model = buildViewModel({
        owner: canonicalDocumentUri(params.owner),
        revision: owned.revision,
        graph: owned.state.graph,
        registry: owned.state.registry,
        analysis: owned.state.analysis,
        uriOfSource,
        documents: owned.state.documents,
        ...(params.configuration ? { configuration: params.configuration } : {}),
      });
      models.set(key, model);
    }
    return model;
  });

  connection.onRequest(TeloMethod.celCompletion, (params: CelCompletionParams): CelCompletionResult => {
    const owned = session.ownerAnalysis(params.owner);
    if (!owned) return [];
    return celCompletionAt(owned.state.analysis, params).map(toCompletionItem) as CelCompletionResult;
  });
}
