import { celFieldCompletions, type CelFieldSite } from "./cel-field-completion";
import type { LanguageSession } from "./language-session";
import type { MonacoApi } from "./lsp-to-monaco";

/** Its own language id rather than a mode of `yaml`: the bridge registers the
 *  engines' providers on `yaml`, and a model holding a bare CEL body is not a
 *  YAML document — offering it a manifest key would be a completion that cannot
 *  apply. */
export const CEL_FIELD_LANGUAGE_ID = "telo-cel";

/** The form field a CEL model holds the value of, and the session whose engine
 *  completes it. */
export interface CelFieldBinding {
  session: Pick<LanguageSession, "celCompletion">;
  site: CelFieldSite;
}

/** Which field each open CEL model belongs to, by model URI. Monaco resolves a
 *  completion provider per LANGUAGE, so the provider is registered once and
 *  reads its field per model — several fields can be open at once. */
const bindings = new Map<string, CelFieldBinding>();
const registeredOn = new WeakSet<MonacoApi>();

/** Registers the CEL field language and its completion provider on `monaco`,
 *  once per runtime. */
export function registerCelFieldLanguage(monaco: MonacoApi): void {
  if (registeredOn.has(monaco)) return;
  registeredOn.add(monaco);
  monaco.languages.register({ id: CEL_FIELD_LANGUAGE_ID });
  monaco.languages.registerCompletionItemProvider(CEL_FIELD_LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const binding = bindings.get(model.uri.toString());
      if (!binding) return { suggestions: [] };
      return celFieldCompletions(monaco, binding.session, binding.site, model, position);
    },
  });
}

/** Binds the model at `uri` to a field, or unbinds it with `undefined` — a
 *  field with no session to ask is offered no completion. */
export function bindCelField(uri: string, binding: CelFieldBinding | undefined): void {
  if (binding) bindings.set(uri, binding);
  else bindings.delete(uri);
}
