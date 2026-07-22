import type { OnMount } from "@monaco-editor/react";

type Monaco = Parameters<OnMount>[1];

/** Semantic-token colors keyed by the ide-support token types
 *  (`type` = resource kind, `interface` = capability, `variable` = `!ref`
 *  target). Monaco maps a semantic token type to a theme rule whose `token`
 *  equals the type name, so these paint the tokens `buildSemanticTokens` emits.
 *  Colors mirror the VS Code Dark+/Light+ conventions used by the extension's
 *  TextMate grammar. */
const DARK_RULES = [
  { token: "type", foreground: "4EC9B0" },
  { token: "interface", foreground: "4EC9B0" },
  { token: "variable", foreground: "9CDCFE" },
];
const LIGHT_RULES = [
  { token: "type", foreground: "267F99" },
  { token: "interface", foreground: "267F99" },
  { token: "variable", foreground: "001080" },
];

/** Register the Telo themes — the built-in `vs-dark`/`vs` plus semantic-token
 *  color rules. Idempotent; safe to call on every editor mount. */
export function defineTeloThemes(monaco: Monaco): void {
  monaco.editor.defineTheme("telo-dark", {
    base: "vs-dark",
    inherit: true,
    rules: DARK_RULES,
    colors: {},
  });
  monaco.editor.defineTheme("telo-light", {
    base: "vs",
    inherit: true,
    rules: LIGHT_RULES,
    colors: {},
  });
}

export function teloThemeName(monacoTheme: "vs-dark" | "light"): "telo-dark" | "telo-light" {
  return monacoTheme === "vs-dark" ? "telo-dark" : "telo-light";
}
