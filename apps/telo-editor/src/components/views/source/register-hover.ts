import type { OnMount } from "@monaco-editor/react";
import type { Position, editor, languages } from "monaco-editor";
import { buildHover } from "@telorun/ide-support";
import { registryRef, threadedDocs, toMonacoRange } from "./provider-state";

type Monaco = Parameters<OnMount>[1];

export function registerYamlHover(monaco: Monaco): void {
  monaco.languages.registerHoverProvider("yaml", {
    provideHover(model: editor.ITextModel, position: Position): languages.Hover | undefined {
      const text = model.getValue();
      const result = buildHover(
        text,
        position.lineNumber - 1,
        position.column - 1,
        registryRef.current,
        threadedDocs(text),
      );
      if (!result) return undefined;
      return {
        contents: [{ value: result.contents }],
        range: result.range ? toMonacoRange(result.range) : undefined,
      };
    },
  });
}
