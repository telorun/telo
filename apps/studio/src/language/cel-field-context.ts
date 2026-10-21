import { createContext, useContext } from "react";
import type { LanguageSession } from "./language-session";

/** Where a form's CEL field asks for completion: the language session and the
 *  module the form edits. */
export interface CelFieldSource {
  session: Pick<LanguageSession, "celCompletion">;
  modulePath: string;
}

export const CelFieldContext = createContext<CelFieldSource | null>(null);

export function useCelFieldSource(): CelFieldSource | null {
  return useContext(CelFieldContext);
}
