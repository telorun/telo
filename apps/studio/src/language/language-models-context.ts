import { createContext, useContext } from "react";
import type { MonacoApi } from "./lsp-to-monaco";
import type { ModelProjections } from "./model-projections";

/** The Monaco runtime holding the workspace's document models, and where an
 *  editor showing part of one registers its projection. */
export interface LanguageModels {
  monaco: MonacoApi;
  projections: ModelProjections;
}

export const LanguageModelsContext = createContext<LanguageModels | null>(null);

export function useLanguageModels(): LanguageModels | null {
  return useContext(LanguageModelsContext);
}
