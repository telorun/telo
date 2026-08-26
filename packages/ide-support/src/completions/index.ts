export { buildCompletions } from "./build.js";
export type { CompletionCtx } from "./detect-context.js";
// The CEL half on its own, for a host completing an expression that is not in a
// YAML document: studio's schema form edits a `!cel` body in a field, so it has
// the site's address directly and nothing to detect a context from.
// `buildCompletions` stays the entry point for a document plus a cursor.
export { celCompletions } from "./cel-completions.js";
export type { CelCompletionTarget } from "./cel-completions.js";
