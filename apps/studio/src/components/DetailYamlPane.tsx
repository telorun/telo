import { useEffect, useMemo, useRef, useState } from "react";
import { pathToFileUri } from "../language/file-uri";
import { useLanguageModels } from "../language/language-models-context";
import type { ModuleDocument, ModuleSourceFile } from "../model";
import { CodeEditor } from "./code-editor";
import { YamlSliceProjection, type SliceView } from "./detail-yaml-projection";
import { findResourceDocument } from "./detail-yaml-slice";
import { commitSourceText } from "./views/source/commit-source-text";

const DEBOUNCE_MS = 500;

interface DetailYamlPaneProps {
  sourceFiles: ModuleSourceFile[];
  resource: { kind: string; name: string };
  /** JSON pointer into the resource, or "" for the whole resource document. */
  pointer: string;
  readOnly: boolean;
  onSourceEdit: (filePath: string, moduleDoc: ModuleDocument) => void;
}

let projectedModels = 0;

/**
 * The selected node's own YAML, editable in place — a live projection of its
 * document's model, the one the language engine analyses and the source view
 * edits.
 *
 * The pane holds no text of its own. A keystroke is spliced into the document
 * model at once (so completion, hover, rename and diagnostics are the engine's,
 * served through that document), and whatever else changes the document — the
 * source view, a rename, an engine edit, the workspace — re-derives the pane.
 * The span shown is the AUTHOR'S BYTES, dedented; the form's path diffs a
 * projected fields object and loses the comments inside a replaced subtree, so
 * reading and writing the same span is what keeps the pane symmetric.
 *
 * Committing to the workspace is the source view's path over the document's
 * text, after the same debounce: validity is judged on the WHOLE FILE, never on
 * the slice, which is often not a standalone YAML document, and unparseable text
 * is never committed.
 */
export function DetailYamlPane({ sourceFiles, resource, pointer, readOnly, onSourceEdit }: DetailYamlPaneProps) {
  const languageModels = useLanguageModels();
  const filePath = useMemo(
    () =>
      sourceFiles.find((f) => !f.parseError && findResourceDocument(f.documents, resource.kind, resource.name))
        ?.filePath,
    [sourceFiles, resource.kind, resource.name],
  );

  // A document model appears once the workspace's models are built; wait for it
  // rather than showing a pane nothing serves.
  const [modelsChanged, setModelsChanged] = useState(0);
  useEffect(() => {
    if (!languageModels) return;
    const created = languageModels.monaco.editor.onDidCreateModel(() => setModelsChanged((n) => n + 1));
    return () => created.dispose();
  }, [languageModels]);
  const document = useMemo(
    () =>
      languageModels && filePath
        ? languageModels.monaco.editor.getModel(languageModels.monaco.Uri.parse(pathToFileUri(filePath)))
        : null,
    // `modelsChanged` re-reads a model created since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [languageModels, filePath, modelsChanged],
  );

  const [view, setView] = useState<SliceView | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const projectionRef = useRef<YamlSliceProjection | null>(null);
  const [projectedUri, setProjectedUri] = useState<string | null>(null);

  const readOnlyRef = useRef(readOnly);
  const onSourceEditRef = useRef(onSourceEdit);
  readOnlyRef.current = readOnly;
  onSourceEditRef.current = onSourceEdit;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!languageModels || !document || !filePath) return;
    const { monaco, projections } = languageModels;
    const commit = () => {
      timerRef.current = undefined;
      setParseError(commitSourceText(filePath, document.getValue(), onSourceEditRef.current));
    };
    const model = monaco.editor.createModel(
      "",
      "yaml",
      monaco.Uri.parse(`${projections.scheme}:///${++projectedModels}${encodeURI(filePath)}`),
    );
    const projection: YamlSliceProjection = new YamlSliceProjection(
      model,
      document,
      { filePath, kind: resource.kind, name: resource.name, pointer },
      setView,
      () => projections.changed(projection),
    );
    const registration = projections.add(projection);
    projectionRef.current = projection;
    setView(projection.current());
    setParseError(null);
    setProjectedUri(model.uri.toString());
    return () => {
      // Moving to another node, or leaving the pane, inside the debounce window
      // commits what was typed rather than dropping it.
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        if (!readOnlyRef.current) commit();
      }
      projectionRef.current = null;
      registration.dispose();
      projection.dispose();
      model.dispose();
    };
  }, [languageModels, document, filePath, resource.kind, resource.name, pointer]);

  function handleChange(next: string) {
    const projection = projectionRef.current;
    if (!projection || projection.isDeriving() || readOnlyRef.current || !filePath || !document) return;
    projection.edit(next);
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      if (readOnlyRef.current) return;
      setParseError(commitSourceText(filePath, document.getValue(), onSourceEditRef.current));
    }, DEBOUNCE_MS);
  }

  const message = !filePath
    ? "No source document found for this resource."
    : !document
      ? `${filePath} has no editor model yet, so its YAML cannot be shown or edited.`
      : view && "error" in view
        ? view.error
        : null;
  if (message || !view || "error" in view || !projectedUri) {
    return <p className="p-3 text-xs text-zinc-400 dark:text-zinc-600">{message}</p>;
  }

  return (
    <div className="flex h-full flex-col">
      {parseError && (
        <p className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-700 dark:text-red-300">
          {parseError}
        </p>
      )}
      <div className="min-h-0 flex-1 p-2">
        <CodeEditor
          path={projectedUri}
          value={view.text}
          onValueChange={handleChange}
          mimeType="application/yaml"
          height="100%"
          readOnly={readOnly}
          className="h-full"
        />
      </div>
    </div>
  );
}
