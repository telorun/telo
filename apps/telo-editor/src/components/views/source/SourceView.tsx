import Editor, { type OnMount } from "@monaco-editor/react";
import type { PositionIndex } from "@telorun/analyzer";
import { normalizeDiagnostic } from "@telorun/ide-support";
import type { ResourceManifest } from "@telorun/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDiagnosticsContext } from "../../diagnostics/DiagnosticsContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { ViewProps } from "../types";
import { parseModuleDocument } from "../../../yaml-document";
import { toMonacoMarker } from "./markers";
import { registerYamlCompletions } from "./register-completion";

const DEBOUNCE_MS = 500;

type MonacoEditor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

interface TabState {
  /** The user's current Monaco buffer for this tab. Seeded from
   *  `viewData.sourceFiles[i].text` on first activation and whenever the
   *  external on-disk text changes while the tab is not dirty. Authoritative
   *  source of the displayed text when `dirty === true`. */
  localText: string;
  /** True once the user types in this tab; flips back to false after a
   *  successful debounce-fire parse (which also commits via onSourceEdit). */
  dirty: boolean;
  /** Parser error message when the latest debounce-fire failed to parse
   *  the tab's text. Non-null means the tab shows a red marker and we've
   *  skipped calling onSourceEdit for this tab's last committed attempt. */
  parseError: string | null;
}

/** Detects whether the incoming canonical text for a tab has advanced past
 *  what the tab previously recorded. Used to distinguish "external update
 *  we should absorb" from "our own prior commit bouncing back through
 *  workspace.documents" — though in practice this is a simple string diff:
 *  if the tab isn't dirty and the canonical text differs from what the tab
 *  last showed, we update. */

export function SourceView({ viewData, onSourceEdit, revealRequest }: ViewProps) {
  const sourceFiles = viewData.sourceFiles;
  const firstFilePath = sourceFiles[0]?.filePath;
  const lastConsumedNonceRef = useRef<number | null>(null);

  // Active tab is tracked explicitly so module-change resets to owner, and
  // so we can focus a specific tab on parse error when a future "block
  // module switch on dirty-and-invalid" flow is added.
  const [activeTab, setActiveTab] = useState<string | undefined>(firstFilePath);

  // Reset active tab when the module changes (different owner path or tab
  // list). Without this, switching modules keeps a stale tab id that no
  // longer exists in the current sourceFiles list.
  useEffect(() => {
    if (activeTab && sourceFiles.some((f) => f.filePath === activeTab)) return;
    setActiveTab(firstFilePath);
  }, [activeTab, firstFilePath, sourceFiles]);

  // Per-tab state indexed by filePath. Initialized lazily on first render;
  // hydrated / invalidated when the external canonical text changes while a
  // tab is not dirty.
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});

  // Per-tab debounce timers. Kept as a ref because they're imperative — we
  // don't want a state update on every timer schedule.
  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Monaco editor + monaco instance refs keyed by filePath. Used to set /
  // clear error markers per tab.
  const editorsRef = useRef<Record<string, MonacoEditor>>({});
  const monacoRef = useRef<Monaco | null>(null);

  // Keep tabStates in sync with external (form-edit) ModuleDocument.text
  // changes. Rule: a non-dirty tab tracks the AST; a dirty tab owns its
  // text until the user commits. This is where the Phase 4 flicker fix
  // lives — we replace `localText` only when the tab isn't dirty AND the
  // canonical text actually differs.
  useEffect(() => {
    setTabStates((prev) => {
      let changed = false;
      const next: Record<string, TabState> = {};
      const seen = new Set<string>();

      for (const file of sourceFiles) {
        seen.add(file.filePath);
        const existing = prev[file.filePath];
        if (!existing) {
          next[file.filePath] = {
            localText: file.text,
            dirty: false,
            parseError: file.parseError ?? null,
          };
          changed = true;
          continue;
        }
        // Dirty tab: don't touch buffer. Clear a stale parseError only if
        // the AST is clean and we're no longer showing an error the user
        // has since fixed — but we already track parseError locally and
        // update it from debounce parse, so leave it alone here.
        if (existing.dirty) {
          next[file.filePath] = existing;
          continue;
        }
        // Non-dirty: resync localText when canonical text differs.
        if (existing.localText !== file.text) {
          next[file.filePath] = {
            localText: file.text,
            dirty: false,
            parseError: file.parseError ?? null,
          };
          changed = true;
          continue;
        }
        // Canonical text unchanged — keep existing (including any live
        // parseError so the marker doesn't flicker).
        next[file.filePath] = existing;
      }

      // Drop entries for files no longer in the module. Needed when the
      // active module changes or when a partial is removed via an edit.
      for (const key of Object.keys(prev)) {
        if (!seen.has(key)) changed = true;
      }

      return changed ? next : prev;
    });
  }, [sourceFiles]);

  // When a non-dirty tab's localText changes (via the useEffect above from
  // an upstream workspace edit), push that text into the tab's Monaco
  // editor via setValue so the visible buffer matches. Monaco's default
  // setValue preserves cursor position. We don't push when dirty — the
  // user's typing wins.
  useEffect(() => {
    for (const [filePath, state] of Object.entries(tabStates)) {
      if (state.dirty) continue;
      const editor = editorsRef.current[filePath];
      if (!editor) continue;
      const model = editor.getModel();
      if (!model) continue;
      if (model.getValue() !== state.localText) {
        model.setValue(state.localText);
      }
    }
  }, [tabStates]);

  // Cleanup debounce timers on unmount (module switch, workspace close).
  useEffect(() => {
    const timers = debounceRefs.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  // Reveal-request effect. `navigateToDiagnostic` in Editor bumps a monotonic
  // nonce; we consume it once per value. Remounts (view switch → back) see
  // the same nonce and skip via `lastConsumedNonceRef` so we don't re-reveal
  // after the user has scrolled away.
  useEffect(() => {
    if (!revealRequest) return;
    if (revealRequest.nonce === lastConsumedNonceRef.current) return;
    const { filePath, range, nonce } = revealRequest;
    const fileExists = sourceFiles.some((f) => f.filePath === filePath);
    if (!fileExists) return;

    if (activeTab !== filePath) setActiveTab(filePath);

    const tryReveal = (attempt: number) => {
      const editor = editorsRef.current[filePath];
      if (!editor) {
        if (attempt < 20) {
          requestAnimationFrame(() => tryReveal(attempt + 1));
        }
        return;
      }
      if (range) {
        const mr = {
          startLineNumber: range.start.line + 1,
          startColumn: range.start.character + 1,
          endLineNumber: range.end.line + 1,
          endColumn: range.end.character + 1,
        };
        editor.revealRangeInCenter(mr);
        editor.setSelection(mr);
        editor.focus();
      }
      lastConsumedNonceRef.current = nonce;
    };
    tryReveal(0);
    // Intentionally keyed on nonce only — object-identity deps would fire
    // on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest?.nonce]);

  function setMarker(filePath: string, message: string | null) {
    const editor = editorsRef.current[filePath];
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    if (message == null) {
      monaco.editor.setModelMarkers(model, "yaml-parse", []);
      return;
    }
    monaco.editor.setModelMarkers(model, "yaml-parse", [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      },
    ]);
  }

  // Bumped in handleMount so the marker effect runs once editors are actually
  // attached. Without this, first-render markers would miss (onMount fires
  // after effects, so `editorsRef.current[filePath]` is undefined on the
  // initial pass).
  const [mountTick, setMountTick] = useState(0);

  const handleMount = useCallback(
    (filePath: string): OnMount =>
      (editor, monaco) => {
        editorsRef.current[filePath] = editor;
        monacoRef.current = monaco;
        registerYamlCompletions(monaco);
        setMountTick((t) => t + 1);
      },
    [],
  );

  // Push analyzer diagnostics to Monaco markers under owner "telo". The
  // existing `setMarker` path uses owner "yaml-parse" and handles parse
  // errors — Monaco composes markers across owners per model, so both
  // coexist. Keyed on diagnostics + file list so each analysis pass writes
  // fresh markers (including clearing stale ones on files whose diagnostics
  // dropped to empty).
  const diagnosticsCtx = useDiagnosticsContext();
  const workspaceDiagnostics = diagnosticsCtx?.diagnostics;
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !workspaceDiagnostics) return;

    for (const file of sourceFiles) {
      const editor = editorsRef.current[file.filePath];
      const model = editor?.getModel();
      if (!model) continue;

      const fileBucket = workspaceDiagnostics.byFile.get(file.filePath) ?? [];
      const resourceBuckets = Array.from(
        workspaceDiagnostics.byResource.get(file.filePath)?.values() ?? [],
      ).flat();
      const diags = [...fileBucket, ...resourceBuckets];

      const markers = diags.map((d) => {
        const name = (d.data as { resource?: { name?: string } } | undefined)?.resource?.name;
        const m: ResourceManifest | undefined = name
          ? workspaceDiagnostics.manifestsByResource.get(`${file.filePath}::${name}`)
          : undefined;
        const meta = m?.metadata as
          | { positionIndex?: PositionIndex; sourceLine?: number }
          | undefined;
        const normalized = normalizeDiagnostic(d, {
          registry: workspaceDiagnostics.registry,
          positionIndex: meta?.positionIndex,
          sourceLine: meta?.sourceLine,
        });
        return toMonacoMarker(normalized, monaco);
      });

      monaco.editor.setModelMarkers(model, "telo", markers);
    }
  }, [workspaceDiagnostics, sourceFiles, mountTick]);

  // Not memoized via useCallback: the inner `commit` closure and the
  // `onSourceEdit` prop both change identity across renders, and a
  // first-render-captured handleChange would fire its debounce timer
  // against stale state. Re-creating this function each render is cheap
  // (Monaco's <Editor> doesn't memoize on onChange identity), and it
  // guarantees that when the 500ms timer fires it calls the latest
  // `commit` / `onSourceEdit`.
  function handleChange(filePath: string, value: string | undefined) {
    if (value == null) return;
    setTabStates((prev) => ({
      ...prev,
      [filePath]: {
        localText: value,
        dirty: true,
        parseError: prev[filePath]?.parseError ?? null,
      },
    }));

    const existing = debounceRefs.current[filePath];
    if (existing) clearTimeout(existing);
    debounceRefs.current[filePath] = setTimeout(() => {
      delete debounceRefs.current[filePath];
      commit(filePath, value);
    }, DEBOUNCE_MS);
  }

  function commit(filePath: string, text: string) {
    // Single parse: `parseModuleDocument` packages the parse result +
    // error aggregation into a `ModuleDocument` that is handed straight
    // to `onSourceEdit`, so the Editor doesn't re-parse.
    const moduleDoc = parseModuleDocument(filePath, text);
    if (moduleDoc.parseError) {
      setTabStates((prev) => ({
        ...prev,
        [filePath]: {
          localText: text,
          dirty: true,
          parseError: moduleDoc.parseError ?? null,
        },
      }));
      setMarker(filePath, moduleDoc.parseError ?? null);
      return;
    }

    setMarker(filePath, null);
    setTabStates((prev) => ({
      ...prev,
      [filePath]: {
        localText: text,
        dirty: false,
        parseError: null,
      },
    }));
    onSourceEdit(filePath, moduleDoc);
  }

  // Prepare a list of tabs to render. Avoids re-computing on every keystroke
  // by memoizing on sourceFiles.
  const tabs = useMemo(() => sourceFiles, [sourceFiles]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">No manifest to display</span>
      </div>
    );
  }

  // Single-file module: skip the tab strip chrome.
  if (tabs.length === 1) {
    const file = tabs[0];
    const state = tabStates[file.filePath];
    const displayText = state?.localText ?? file.text;
    const errorToShow = state?.parseError ?? file.parseError ?? null;
    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-200 px-3 dark:border-zinc-800">
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={file.filePath}>
            {file.filePath}
          </span>
          {errorToShow && (
            <span className="truncate text-xs text-red-500 dark:text-red-400" title={errorToShow}>
              Parse error
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            key={file.filePath}
            height="100%"
            language="yaml"
            defaultValue={displayText}
            onChange={(value) => handleChange(file.filePath, value)}
            onMount={handleMount(file.filePath)}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </div>
      </div>
    );
  }

  // Multi-file module: editable tab per file.
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        orientation="vertical"
        className="min-h-0 flex-1 !flex-row gap-0"
      >
        <TabsList
          variant="line"
          className="h-auto w-48 shrink-0 flex-col items-stretch justify-start overflow-y-auto rounded-none border-r border-zinc-200 p-0 dark:border-zinc-800"
        >
          {tabs.map((file) => {
            const state = tabStates[file.filePath];
            const hasError = !!(state?.parseError ?? file.parseError);
            return (
              <TabsTrigger
                key={file.filePath}
                value={file.filePath}
                className="h-auto flex-none justify-start rounded-none border-b border-zinc-100 px-2 py-2 text-left text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-900 dark:border-zinc-800 dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-zinc-100"
                title={file.filePath}
              >
                <span className="line-clamp-2 break-all">
                  {file.filePath}
                  {state?.dirty ? " •" : ""}
                  {hasError ? " ⚠" : ""}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        {tabs.map((file) => {
          const state = tabStates[file.filePath];
          const displayText = state?.localText ?? file.text;
          return (
            <TabsContent
              key={file.filePath}
              value={file.filePath}
              forceMount
              className="min-h-0 min-w-0 data-[state=inactive]:hidden"
            >
              <Editor
                key={file.filePath}
                height="100%"
                language="yaml"
                defaultValue={displayText}
                onChange={(value) => handleChange(file.filePath, value)}
                onMount={handleMount(file.filePath)}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
