import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAllDocuments } from "yaml";
import type { ResourceManifest } from "@telorun/sdk";
import { buildParsedManifest, getMultiFileSnapshots } from "../../../loader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { ViewProps } from "../types";

const DEBOUNCE_MS = 500;

/**
 * Parses a multi-document YAML string into ResourceManifest[].
 * Returns an error string on failure.
 */
function parseYamlToManifests(text: string): { docs: ResourceManifest[] } | { error: string } {
  try {
    const parsed = parseAllDocuments(text);
    const errors = parsed.flatMap((d) => d.errors);
    if (errors.length > 0) {
      return { error: errors.map((e) => e.message).join("\n") };
    }
    const docs = parsed
      .map((d) => d.toJSON())
      .filter((d): d is ResourceManifest => d != null && typeof d === "object" && d.kind);
    return { docs };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function SourceView({ viewData, onReplaceManifest }: ViewProps) {
  const snapshots = useMemo(
    () => getMultiFileSnapshots(viewData.manifest),
    [viewData.manifest],
  );

  // Track whether the user is actively editing to avoid overwriting their text
  const [dirty, setDirty] = useState(false);
  const [localText, setLocalText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  // When the manifest changes externally and we're not dirty, reset
  const canonicalYaml = snapshots.length === 1 ? snapshots[0].yaml : null;
  useEffect(() => {
    if (!dirty && canonicalYaml != null) {
      setLocalText(canonicalYaml);
      setParseError(null);
      clearMarkers();
    }
  }, [canonicalYaml, dirty]);

  function clearMarkers() {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) monacoRef.current.editor.setModelMarkers(model, "yaml-parse", []);
    }
  }

  function setErrorMarkers(message: string) {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;
    monacoRef.current.editor.setModelMarkers(model, "yaml-parse", [
      {
        severity: monacoRef.current.MarkerSeverity.Error,
        message,
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      },
    ]);
  }

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value == null) return;
      setDirty(true);
      setLocalText(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const result = parseYamlToManifests(value);
        if ("error" in result) {
          setParseError(result.error);
          setErrorMarkers(result.error);
          return;
        }

        setParseError(null);
        clearMarkers();

        const manifest = buildParsedManifest(viewData.manifest.filePath, result.docs);
        // Preserve fields that buildParsedManifest doesn't reconstruct from YAML
        manifest.metadata.variables = manifest.metadata.variables ?? viewData.manifest.metadata.variables;
        manifest.metadata.secrets = manifest.metadata.secrets ?? viewData.manifest.metadata.secrets;
        manifest.metadata.namespace = manifest.metadata.namespace ?? viewData.manifest.metadata.namespace;

        onReplaceManifest(manifest);
        setDirty(false);
      }, DEBOUNCE_MS);
    },
    [viewData.manifest, onReplaceManifest],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };

  if (snapshots.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">No manifest to display</span>
      </div>
    );
  }

  // Single file — editable
  if (snapshots.length === 1) {
    const displayText = dirty ? localText : snapshots[0].yaml;
    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-200 px-3 dark:border-zinc-800">
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={snapshots[0].filePath}>
            {snapshots[0].filePath}
          </span>
          {parseError && (
            <span className="truncate text-xs text-red-500 dark:text-red-400" title={parseError}>
              Parse error
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language="yaml"
            value={displayText}
            onChange={handleChange}
            onMount={handleEditorMount}
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

  // Multi-file — tabs, read-only for now (editing included files is complex)
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <Tabs
        defaultValue={snapshots[0].filePath}
        orientation="vertical"
        className="min-h-0 flex-1 !flex-row gap-0"
      >
        <TabsList
          variant="line"
          className="h-auto w-48 shrink-0 flex-col items-stretch justify-start overflow-y-auto rounded-none border-r border-zinc-200 p-0 dark:border-zinc-800"
        >
          {snapshots.map((s) => (
            <TabsTrigger
              key={s.filePath}
              value={s.filePath}
              className="h-auto flex-none justify-start rounded-none border-b border-zinc-100 px-2 py-2 text-left text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-900 dark:border-zinc-800 dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-zinc-100"
              title={s.filePath}
            >
              <span className="line-clamp-2 break-all">{s.filePath}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {snapshots.map((s) => (
          <TabsContent key={s.filePath} value={s.filePath} className="min-h-0 min-w-0">
            <Editor
              height="100%"
              language="yaml"
              value={s.yaml}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
