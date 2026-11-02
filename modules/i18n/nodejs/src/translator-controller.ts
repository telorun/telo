import {
  formatMessage,
  isCelUint,
  readMessage,
  type FunctionController,
  type Message,
  type MessageSource,
  type MessageValue,
  type ResourceManifest,
  type TextRecord,
} from "@telorun/sdk";

interface TranslateArgs extends Record<string, unknown> {
  text: TextRecord;
  lang: string;
  values?: Record<string, unknown> | null;
}

/** A CEL `uint` is formatted as the integer it is. */
function messageValues(values: Record<string, unknown>): Record<string, MessageValue> {
  const out: Record<string, MessageValue> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] = (isCelUint(value) ? value.value : value) as MessageValue;
  }
  return out;
}

function parsed(source: MessageSource): Message {
  const read = readMessage(source);
  if (!read.ok) {
    throw new Error(`the text is not a message: ${read.problems.map((problem) => problem.message).join("; ")}`);
  }
  return read.message;
}

/**
 * `I18n.Translator`: a text translated by the application's translations into
 * the language asked for, formatted in the language reached.
 */
export const Translator: FunctionController<ResourceManifest, TranslateArgs, string> = {
  create(resource, ctx) {
    return {
      call({ text, lang, values }) {
        const shown = ctx.translations.translate(lang, text);
        return formatMessage(parsed(shown.text), shown.lang, messageValues(values ?? {}));
      },
    };
  },
};
