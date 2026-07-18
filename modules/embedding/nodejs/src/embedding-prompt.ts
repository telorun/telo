import type { EmbeddingIntent } from "./embedding-model.js";

/** Placeholder a prompt template must contain; replaced with the input text. */
const TEXT_PLACEHOLDER = "{text}";

/**
 * The prompt templates every Embedding.Model implementation inherits from the
 * abstract's schema. Asymmetric checkpoints (embeddinggemma, E5, BGE) mandate a
 * fixed wrapper per retrieval intent; symmetric ones leave both unset.
 */
export interface EmbeddingPrompts {
  queryPrompt?: string;
  passagePrompt?: string;
}

const FIELD: Record<EmbeddingIntent, keyof EmbeddingPrompts> = {
  query: "queryPrompt",
  passage: "passagePrompt",
};

/**
 * Validate a model's declared templates once, at `create()`. Backends call this
 * in their constructor so a malformed template fails at boot rather than on the
 * first embed — and, worse, rather than poisoning an index that only reveals
 * the damage as degraded recall.
 */
export function resolveEmbeddingPrompts(
  prompts: EmbeddingPrompts,
  label: string,
): EmbeddingPrompts {
  for (const intent of ["query", "passage"] as const) {
    const field = FIELD[intent];
    const template = prompts[field];
    if (template === undefined) continue;
    if (typeof template !== "string" || !template.includes(TEXT_PLACEHOLDER)) {
      throw new Error(
        `${label}: '${field}' must be a string containing the ${TEXT_PLACEHOLDER} placeholder — ` +
          `without it every input embeds to the same constant text. Received: ${JSON.stringify(template)}`,
      );
    }
  }
  return { queryPrompt: prompts.queryPrompt, passagePrompt: prompts.passagePrompt };
}

/**
 * Wrap each text in the template declared for `intent`. Returns the texts
 * unchanged when the model declares no template for that side, so symmetric
 * backends need no special-casing.
 */
export function applyEmbeddingPrompt(
  texts: string[],
  intent: EmbeddingIntent,
  prompts: EmbeddingPrompts,
): string[] {
  const template = prompts[FIELD[intent]];
  if (template === undefined) return texts;
  // split/join, not replace/replaceAll: a `$&` or `$1` in the input text would
  // be interpreted as a replacement pattern and silently corrupt the passage.
  return texts.map((text) => template.split(TEXT_PLACEHOLDER).join(text));
}
