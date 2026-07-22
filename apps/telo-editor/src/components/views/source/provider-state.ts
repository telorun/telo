import type { AnalysisRegistry, AstDocument, LoadedGraph, Range } from "@telorun/analyzer";
import type { IPosition, IRange } from "monaco-editor";
import type { AppSettings, WorkspaceAdapter } from "../../../model";

/** Live inputs the Monaco language providers read at request time. Providers are
 *  registered once per Monaco runtime (see `register-language-features`), so all
 *  mutable state flows through these module-scoped refs, pushed from Editor.tsx
 *  after each analysis pass — the same pattern the completion provider has always
 *  used, now shared by hover / semantic-tokens / definition too. */
export const registryRef: { current: AnalysisRegistry | undefined } = { current: undefined };
export const workspaceRef: { current: WorkspaceAdapter | undefined } = { current: undefined };
export const settingsRef: { current: AppSettings | undefined } = { current: undefined };
export const graphRef: { current: LoadedGraph | undefined } = { current: undefined };
/** The active module's owner path — the current file for definition resolution.
 *  Every source tab belongs to the active module, so its owner path identifies
 *  the module in the graph regardless of which tab is focused. */
export const currentPathRef: { current: string | undefined } = { current: undefined };
/** Bridges cross-file go-to-definition into the app's own navigation (activate
 *  the owning module + reveal the range) — Monaco can't open a file that has no
 *  live model on its own. */
export const navigatorRef: { current: ((filePath: string, range?: Range) => void) | undefined } = {
  current: undefined,
};
/** The active file's already-parsed AST plus the exact text it was parsed from.
 *  Reused only when the live buffer still matches, so a keystroke ahead of the
 *  next analysis pass falls back to a local parse rather than a stale tree. */
export const docsRef: { current: { text: string; docs: AstDocument[] } | undefined } = {
  current: undefined,
};

export function setActiveRegistry(r: AnalysisRegistry | undefined): void {
  registryRef.current = r;
}
export function setActiveDocs(entry: { text: string; docs: AstDocument[] } | undefined): void {
  docsRef.current = entry;
}
export function setActiveWorkspaceAdapter(a: WorkspaceAdapter | undefined): void {
  workspaceRef.current = a;
}
export function setActiveSettings(s: AppSettings | undefined): void {
  settingsRef.current = s;
}
export function setActiveGraph(g: LoadedGraph | undefined): void {
  graphRef.current = g;
}
export function setActiveCurrentPath(p: string | undefined): void {
  currentPathRef.current = p;
}
export function setActiveNavigator(nav: ((filePath: string, range?: Range) => void) | undefined): void {
  navigatorRef.current = nav;
}

/** The cached AST for `model`'s buffer when it still matches `text`, else
 *  undefined so the caller re-parses. */
export function threadedDocs(text: string): AstDocument[] | undefined {
  return docsRef.current && docsRef.current.text === text ? docsRef.current.docs : undefined;
}

/** 0-based ide-support Range → 1-based Monaco range. */
export function toMonacoRange(r: Range): IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/** 1-based Monaco selection/position → 0-based ide-support Range. */
export function toZeroBasedRange(sel: IRange | IPosition): Range {
  if ("startLineNumber" in sel) {
    return {
      start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
      end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
    };
  }
  return {
    start: { line: sel.lineNumber - 1, character: sel.column - 1 },
    end: { line: sel.lineNumber - 1, character: sel.column - 1 },
  };
}
