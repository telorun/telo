/**
 * What identifies a source text, and which names a message reads.
 *
 * A source text's identity is the pattern reached by taking `other` at every
 * selection, in canonical serialization, together with its context. So a translation's
 * shape is free: a plain source may have a plural translation and the key is the same.
 */

import { isPattern, type Message, type Pattern, type Text } from "./message-model.js";
import { serializePattern } from "./pattern-serializer.js";

export interface TextIdentity {
  readonly source: string;
  readonly context: string | null;
}

export function messageIdentity(message: Message): string {
  let at = message;
  while (!isPattern(at)) at = at.cases.other;
  return serializePattern(at as Pattern);
}

export function textIdentity(text: Text): TextIdentity {
  return { source: messageIdentity(text.message), context: text.context };
}

/** Every name the message reads — its placeholders and its selectors — sorted, each once. */
export function messageVariables(message: Message): readonly string[] {
  const names = new Set<string>();
  const pending: Message[] = [message];
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (isPattern(at)) {
      for (const part of at) if (typeof part !== "string") names.add(part.placeholder);
    } else {
      names.add(at.plural);
      pending.push(...Object.values(at.cases));
    }
  }
  return [...names].sort();
}
