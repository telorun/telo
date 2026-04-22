import { createContext, useContext, useMemo, type ReactNode } from "react";
import { AnalysisRegistry, type Range } from "@telorun/analyzer";
import type { WorkspaceDiagnostics } from "../../analysis";

export interface DiagnosticsContextValue {
  /** Opens the source view for `filePath` and reveals `range` when present.
   *  No-ops when `filePath` is the UNKNOWN_FILE_KEY sentinel. */
  navigate: (filePath: string, range?: Range) => void;
  /** Current workspace diagnostics snapshot. Carried on the same context so
   *  UI sites can call aggregation helpers (summarizeResource, summarizeFiles)
   *  without plumbing EditorState through every layer. */
  diagnostics: WorkspaceDiagnostics;
  /** File paths the active module spans (owner + partials). Empty when no
   *  module is active. Deep UI (canvas headers, topology nodes) reads this
   *  so it can call `summarizeResource` without knowing the module shape. */
  activeFilePaths: string[];
}

const DiagnosticsContext = createContext<DiagnosticsContextValue | null>(null);

export function DiagnosticsProvider({
  navigate,
  diagnostics,
  activeFilePaths,
  children,
}: {
  navigate: DiagnosticsContextValue["navigate"];
  diagnostics: WorkspaceDiagnostics;
  activeFilePaths: string[];
  children: ReactNode;
}) {
  const value = useMemo<DiagnosticsContextValue>(
    () => ({ navigate, diagnostics, activeFilePaths }),
    [navigate, diagnostics, activeFilePaths],
  );
  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

export function useDiagnosticsContext(): DiagnosticsContextValue | null {
  return useContext(DiagnosticsContext);
}

/** Convenience: returns a pseudo-EditorState slice suitable for passing to
 *  the aggregation helpers (summarizeResource, summarizeFiles). Returns an
 *  empty WorkspaceDiagnostics if the context is absent, so call sites don't
 *  have to null-check. */
export function useDiagnosticsState(): { diagnostics: WorkspaceDiagnostics } {
  const ctx = useContext(DiagnosticsContext);
  if (ctx) return { diagnostics: ctx.diagnostics };
  return {
    diagnostics: {
      byResource: new Map(),
      byFile: new Map(),
      registry: new AnalysisRegistry(),
      manifestsByResource: new Map(),
    },
  };
}

/** Active module's file paths (owner + partials). Empty array when no module
 *  is active or the context is absent. */
export function useActiveFilePaths(): string[] {
  const ctx = useContext(DiagnosticsContext);
  return ctx?.activeFilePaths ?? [];
}
