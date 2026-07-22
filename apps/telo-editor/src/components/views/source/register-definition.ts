import type { OnMount } from "@monaco-editor/react";
import type { IPosition, IRange, Position, Uri, editor, languages } from "monaco-editor";
import { buildDefinition } from "@telorun/ide-support";
import {
  currentPathRef,
  graphRef,
  navigatorRef,
  threadedDocs,
  toMonacoRange,
  toZeroBasedRange,
} from "./provider-state";

type Monaco = Parameters<OnMount>[1];

/** Editor models here have `inmemory://` URIs, and cross-file targets often have
 *  no live model at all, so a definition Location can't point at a real model.
 *  We encode the target file path into a `telo:` URI and let the editor opener
 *  (below) route the jump through the app's own navigation. */
const SCHEME = "telo";

export function registerYamlDefinition(monaco: Monaco): void {
  monaco.languages.registerDefinitionProvider("yaml", {
    provideDefinition(model: editor.ITextModel, position: Position): languages.Definition | undefined {
      const graph = graphRef.current;
      const currentPath = currentPathRef.current;
      if (!graph || !currentPath) return undefined;

      const text = model.getValue();
      const result = buildDefinition(
        text,
        position.lineNumber - 1,
        position.column - 1,
        graph,
        currentPath,
        threadedDocs(text),
      );
      if (!result) return undefined;

      return {
        uri: monaco.Uri.from({ scheme: SCHEME, path: "/goto", query: result.uri }),
        range: toMonacoRange(result.range),
      };
    },
  });

  // Route every `telo:`-scheme open (a go-to-definition target) through the
  // app's navigation, which activates the owning module and reveals the range —
  // covering same-file and cross-file jumps uniformly.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source: editor.ICodeEditor, resource: Uri, selectionOrPosition?: IRange | IPosition) {
      if (resource.scheme !== SCHEME) return false;
      const navigate = navigatorRef.current;
      if (!navigate) return false;
      const filePath = resource.query;
      navigate(filePath, selectionOrPosition ? toZeroBasedRange(selectionOrPosition) : undefined);
      return true;
    },
  });
}
