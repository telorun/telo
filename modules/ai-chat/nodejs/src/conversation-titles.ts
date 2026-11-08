import { isInvokeError, type InvokeContext } from "@telorun/sdk";
import { ERR_CONVERSATION_CONFLICT, conflictAfterRetries } from "./chat-refusals.js";
import type { OperationCall } from "./operation-call.js";
import { versionOf } from "./turn-plan.js";

const INSTRUCTIONS =
  "You name chat conversations. Answer with a title of three to six words for the conversation below: " +
  "no quotes, no trailing punctuation, nothing else. Write it in the language of the user's message.";

/** How much of the message and the reply a title is written from. */
const EXCERPT = 2000;
/** The longest title kept. */
const MAX_TITLE = 80;
/** How many rounds a title tries against a header that keeps changing. */
const ROUNDS = 3;

const excerpt = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);

/** The messages a title is asked for with: the user's message first, then the reply. */
export function titlePrompt(message: string, reply: string): Array<{ role: string; content: string }> {
  const parts = [excerpt(message.trim()), ...(reply.trim() === "" ? [] : [`---\nThe assistant replied:\n${excerpt(reply.trim())}`])];
  return [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** A model's answer as a title: its first line, without a label, quotes or a trailing stop, cut at a word; none when nothing is left. */
export function cleanTitle(answer: string): string | undefined {
  const line = answer.split("\n").map((each) => each.trim()).find((each) => each !== "") ?? "";
  let title = line
    .replace(/^#+\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, "")
    .replace(/[.。!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE);
    const space = cut.lastIndexOf(" ");
    title = (space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trim();
  }
  return title === "" ? undefined : title;
}

/** Writes a conversation's title with the endpoint's `titles.model`. */
export class ConversationTitler {
  constructor(private readonly model: OperationCall) {}

  async title(message: string, reply: string, ctx: InvokeContext): Promise<string | undefined> {
    const answer = await this.model.invoke<{ text: string }>({ messages: titlePrompt(message, reply) }, ctx);
    return cleanTitle(answer.text);
  }
}

/**
 * Titles a conversation that has none, at the version just read: a title set
 * meanwhile — a rename — is kept, and a conflicting write reads the header again.
 * Nothing is asked of the model when there is no text to name it from.
 */
export async function titleIfUntitled(
  ops: { read: OperationCall; update: OperationCall },
  titler: ConversationTitler,
  conversation: string,
  message: string,
  reply: string,
  ctx: InvokeContext,
): Promise<void> {
  if (message.trim() === "" && reply.trim() === "") return;
  let title: string | undefined;
  for (let round = 0; round < ROUNDS; round++) {
    const header = await ops.read.invoke({ conversation }, ctx);
    if (header.title !== null && header.title !== undefined) return;
    title ??= await titler.title(message, reply, ctx);
    if (title === undefined) return;
    try {
      await ops.update.invoke({ conversation, version: versionOf(header), title }, ctx);
      return;
    } catch (err) {
      if (isInvokeError(err) && err.code === ERR_CONVERSATION_CONFLICT) continue;
      throw err;
    }
  }
  throw conflictAfterRetries(conversation);
}
