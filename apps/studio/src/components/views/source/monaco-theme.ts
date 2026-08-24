import type { OnMount } from "@monaco-editor/react";

type Monaco = Parameters<OnMount>[1];

/**
 * A theme rule's `token` is matched by PREFIX against every token Monaco
 * produces, semantic and Monarch alike — there is one namespace. So the generic
 * entries below (`string`, `keyword`, `number`, `operator`) also govern the YAML
 * grammar's own tokens, not only the ones inside a CEL body. Their values are
 * deliberately the stock `vs-dark` / `vs` palette, so today they repaint nothing;
 * a CEL-only colour change must NOT be made by editing them, or it silently
 * recolours the whole document. Scope such a change to the CEL-specific types
 * (`namespace`, `property`, `function`) instead.
 *
 * Otherwise: colors keyed by the ide-support token types (`type` = resource
 * kind, `interface` = capability, `variable` = `!ref` target). Monaco maps a
 * semantic token type to a theme rule whose `token` equals the type name, so
 * these paint the tokens `buildSemanticTokens` emits. Colors mirror the VS Code
 * Dark+/Light+ conventions used by the extension's TextMate grammar.
 */
const DARK_RULES = [
  { token: "type", foreground: "4EC9B0" },
  { token: "interface", foreground: "4EC9B0" },
  { token: "variable", foreground: "9CDCFE" },
  // Inside a CEL body. Without these the stock YAML grammar paints the whole
  // `!cel "..."` scalar as a string, which is exactly what it is not. The root
  // of a chain is set apart from its members so `request.params.turnId` reads
  // as scope · path rather than one undifferentiated run.
  { token: "namespace", foreground: "4EC9B0" },
  { token: "property", foreground: "9CDCFE" },
  { token: "function", foreground: "DCDCAA" },
  { token: "number", foreground: "B5CEA8" },
  { token: "string", foreground: "CE9178" },
  { token: "keyword", foreground: "569CD6" },
  { token: "operator", foreground: "D4D4D4" },
];
const LIGHT_RULES = [
  { token: "type", foreground: "267F99" },
  { token: "interface", foreground: "267F99" },
  { token: "variable", foreground: "001080" },
  { token: "namespace", foreground: "267F99" },
  { token: "property", foreground: "001080" },
  { token: "function", foreground: "795E26" },
  { token: "number", foreground: "098658" },
  { token: "string", foreground: "A31515" },
  { token: "keyword", foreground: "0000FF" },
  { token: "operator", foreground: "000000" },
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
