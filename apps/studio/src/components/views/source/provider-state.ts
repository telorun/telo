import type { ManifestAnalysis } from "@telorun/analyzer";

/** The analysis of the active module's closure, from studio's bundled model —
 *  what the schema form's CEL editor completes against. Its provider is
 *  registered once per Monaco runtime, so the live value flows through this
 *  module-scoped ref, pushed from Editor.tsx after each model build. */
export const analysisRef: { current: ManifestAnalysis | undefined } = { current: undefined };

export function setActiveAnalysis(a: ManifestAnalysis | undefined): void {
  analysisRef.current = a;
}
