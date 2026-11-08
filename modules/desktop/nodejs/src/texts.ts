import { formatMessage, readMessage, type ResourceContext, type TextRecord } from "@telorun/sdk";

/** A `Text` shown in the application's fallback language, as the host receives it. */
export function shownText(ctx: ResourceContext, record: TextRecord): string {
  const shown = ctx.translations.translate(ctx.translations.fallback, record);
  const read = readMessage(shown.text);
  if (!read.ok) {
    throw new Error(`the text is not a message: ${read.problems.map((problem) => problem.message).join("; ")}`);
  }
  return formatMessage(read.message, shown.lang, {});
}
