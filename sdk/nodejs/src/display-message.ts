import { formatMessage, readMessage, type MessageValue } from "@telorun/message-format";
import { hostValueOf } from "./cel-host-value.js";
import { isCelUint } from "./cel-value-identity.js";
import type { TextRecord } from "./text-record.js";
import { RuntimeError } from "./types.js";

/**
 * An error's display message formatted in the language it is written in, with
 * the error's `data` as its values — what a transport renders untranslated. The
 * kernel judged the pairing when the text was settled, so a text that does not
 * read is a defect and is raised.
 */
export function formatDisplayMessage(text: TextRecord, data: unknown): string {
  const read = readMessage(text.text);
  if (!read.ok) {
    throw new RuntimeError(
      "ERR_MESSAGE_SYNTAX_INVALID",
      `An error's display message does not read: ${read.problems.map((problem) => problem.message).join("; ")}.`,
    );
  }
  const host = hostValueOf(data);
  const values: Record<string, MessageValue> = {};
  if (host && typeof host === "object" && !Array.isArray(host)) {
    for (const [key, value] of Object.entries(host as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") values[key] = value;
      else if (isCelUint(value)) values[key] = value.value;
    }
  }
  return formatMessage(read.message, text.lang, values);
}
