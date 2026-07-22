import type { OnMount } from "@monaco-editor/react";
import type { editor, languages } from "monaco-editor";
import { buildSemanticTokens, SEMANTIC_TOKEN_LEGEND } from "@telorun/ide-support";
import { registryRef, threadedDocs } from "./provider-state";

type Monaco = Parameters<OnMount>[1];

const LEGEND: languages.SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_LEGEND],
  tokenModifiers: [],
};

export function registerYamlSemanticTokens(monaco: Monaco): void {
  monaco.languages.registerDocumentSemanticTokensProvider("yaml", {
    getLegend: () => LEGEND,
    provideDocumentSemanticTokens(model: editor.ITextModel): languages.SemanticTokens {
      const text = model.getValue();
      const tokens = buildSemanticTokens(text, registryRef.current, threadedDocs(text));
      // Monaco wants tokens in reading order, delta-encoded against the previous
      // token: [Δline, Δstart (abs when Δline>0), length, typeIndex, modifiers].
      tokens.sort((a, b) => a.line - b.line || a.character - b.character);
      const data: number[] = [];
      let prevLine = 0;
      let prevChar = 0;
      for (const t of tokens) {
        const deltaLine = t.line - prevLine;
        const deltaChar = deltaLine === 0 ? t.character - prevChar : t.character;
        data.push(deltaLine, deltaChar, t.length, SEMANTIC_TOKEN_LEGEND.indexOf(t.type), 0);
        prevLine = t.line;
        prevChar = t.character;
      }
      return { data: new Uint32Array(data) };
    },
    releaseDocumentSemanticTokens() {},
  });
}
