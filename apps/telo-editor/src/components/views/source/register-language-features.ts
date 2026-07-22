import type { OnMount } from "@monaco-editor/react";
import { defineTeloThemes } from "./monaco-theme";
import { registerYamlCompletions } from "./register-completion";
import { registerYamlDefinition } from "./register-definition";
import { registerYamlHover } from "./register-hover";
import { registerYamlSemanticTokens } from "./register-semantic-tokens";

type Monaco = Parameters<OnMount>[1];

/** Monaco's language providers are process-wide — registering inside a
 *  component mount would stack a duplicate provider per re-mount. A WeakSet
 *  keyed on the monaco instance keeps one registration per runtime. */
const registered = new WeakSet<Monaco>();

/** Define the Telo themes and register every Telo language feature (completion,
 *  hover, semantic tokens, go-to-definition) once per Monaco runtime. Called
 *  from `SourceView`'s `beforeMount` so the themes exist before the first
 *  editor renders. All providers read live analysis state through the shared
 *  refs in `provider-state`. */
export function registerTeloLanguageFeatures(monaco: Monaco): void {
  defineTeloThemes(monaco);
  if (registered.has(monaco)) return;
  registered.add(monaco);

  registerYamlCompletions(monaco);
  registerYamlHover(monaco);
  registerYamlSemanticTokens(monaco);
  registerYamlDefinition(monaco);
}
