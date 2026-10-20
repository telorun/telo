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
  const built = new WeakMap<OwnerAnalysis, ViewModel>();

  connection.onRequest(TeloMethod.viewModel, (params: ViewModelParams): ViewModelResult => {
    const owned = session.ownerAnalysis(params.owner);
    if (!owned) return null;
    let model = built.get(owned.state);
    if (!model) {
      model = buildViewModel({
        owner: canonicalDocumentUri(params.owner),
        revision: owned.revision,
        graph: owned.state.graph,
        registry: owned.state.registry,
        analysis: owned.state.analysis,
        uriOfSource,
        documents: owned.state.documents,
      });
      built.set(owned.state, model);
    }
    return model;
  });

  connection.onRequest(TeloMethod.celCompletion, (params: CelCompletionParams): CelCompletionResult => {
    const owned = session.ownerAnalysis(params.owner);
    if (!owned) return [];
    return celCompletionAt(owned.state.analysis, params).map(toCompletionItem) as CelCompletionResult;
  });
}
