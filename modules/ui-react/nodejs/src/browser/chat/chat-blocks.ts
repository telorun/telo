import type { ChatEvent, Entry, Part, TurnEndReason, Usage } from "./chat-protocol.js";

/** One drawn piece of a message, from a stored entry or built up from a turn's events. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "part"; part: Part }
  | { kind: "tool"; id: string; name?: string; written: string; arguments?: unknown; result?: unknown; isError?: boolean; done: boolean }
  | {
      kind: "approval";
      id: string;
      name: string;
      arguments: unknown;
      decision?: { approved: boolean; reason?: string };
      /** Whether the decision went to the server in a resuming request. */
      sent: boolean;
    };

/** A file the user sent, as the message shows it while its turn runs. */
export interface SentFile {
  name: string;
  /** Whether it is a picture, drawn as a thumbnail where it has a source. */
  image: boolean;
  /** The server's address for it, once it is known. */
  url?: string;
  /** A local object URL for the picture, which the turn shows until the entry is read back and which is revoked with it. */
  preview?: string;
}

/** The turn being written: what the user sent, what has arrived, how it ended. */
export interface LiveTurn {
  user?: { text: string; files: SentFile[] };
  blocks: Block[];
  usage?: Usage;
  end?: TurnEndReason;
  error?: { code: string; detail: string };
}

export const emptyTurn = (user?: LiveTurn["user"]): LiveTurn => ({ user, blocks: [] });

const addUsage = (total: Usage | undefined, step: Usage): Usage => {
  const sum = (key: keyof Usage) => (total?.[key] ?? 0) + (step[key] ?? 0);
  return {
    ...(step.inputTokens !== undefined || total?.inputTokens !== undefined ? { inputTokens: sum("inputTokens") } : {}),
    ...(step.outputTokens !== undefined || total?.outputTokens !== undefined ? { outputTokens: sum("outputTokens") } : {}),
    ...(step.totalTokens !== undefined || total?.totalTokens !== undefined ? { totalTokens: sum("totalTokens") } : {}),
  };
};

/** The block of a tool call by id, created at the end when it is the first word of it. */
function tool(blocks: Block[], id: string): { blocks: Block[]; at: number } {
  const at = blocks.findIndex((block) => block.kind === "tool" && block.id === id);
  if (at !== -1) return { blocks: [...blocks], at };
  return { blocks: [...blocks, { kind: "tool", id, written: "", done: false }], at: blocks.length };
}

const grow = (blocks: Block[], kind: "text" | "reasoning", text: string): Block[] => {
  const last = blocks[blocks.length - 1];
  return last?.kind === kind ? [...blocks.slice(0, -1), { kind, text: last.text + text }] : [...blocks, { kind, text }];
};

/** A turn with one more event applied. An event of a type this renderer does not know changes nothing. */
export function applyEvent(turn: LiveTurn, event: ChatEvent): LiveTurn {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta": {
      const delta = event as { type: string; text: string };
      return { ...turn, blocks: grow(turn.blocks, delta.type === "text-delta" ? "text" : "reasoning", delta.text) };
    }
    case "content": {
      const part = (event as { part: Part }).part;
      // Text arrives as deltas; a completed text part would draw it twice.
      return part.type === "text" || part.type === "reasoning" ? turn : { ...turn, blocks: [...turn.blocks, { kind: "part", part }] };
    }
    case "tool-call-delta": {
      const delta = event as { id: string; name?: string; argumentsDelta: string };
      const { blocks, at } = tool(turn.blocks, delta.id);
      const block = blocks[at] as Extract<Block, { kind: "tool" }>;
      blocks[at] = { ...block, name: delta.name ?? block.name, written: block.written + delta.argumentsDelta };
      return { ...turn, blocks };
    }
    case "tool-call": {
      const call = event as { id: string; name: string; arguments: unknown };
      const { blocks, at } = tool(turn.blocks, call.id);
      blocks[at] = { ...(blocks[at] as Extract<Block, { kind: "tool" }>), name: call.name, arguments: call.arguments, written: "" };
      return { ...turn, blocks };
    }
    case "tool-result": {
      const result = event as { id: string; result: unknown; isError?: boolean };
      const { blocks, at } = tool(turn.blocks, result.id);
      blocks[at] = { ...(blocks[at] as Extract<Block, { kind: "tool" }>), result: result.result, isError: result.isError === true, done: true };
      return { ...turn, blocks };
    }
    case "approval-request": {
      const request = event as { id: string; name: string; arguments: unknown };
      return { ...turn, blocks: [...turn.blocks, { kind: "approval", id: request.id, name: request.name, arguments: request.arguments, sent: false }] };
    }
    case "approval-decision": {
      const decision = event as { id: string; approved: boolean; reason?: string };
      return {
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.kind === "approval" && block.id === decision.id
            ? { ...block, decision: { approved: decision.approved, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) }, sent: true }
            : block,
        ),
      };
    }
    case "step-usage":
      return { ...turn, usage: addUsage(turn.usage, (event as { usage: Usage }).usage) };
    case "turn-end": {
      const end = event as { reason: TurnEndReason; usage?: Usage };
      return { ...turn, end: end.reason, ...(end.usage ? { usage: end.usage } : {}) };
    }
    case "error":
      return { ...turn, error: { code: (event as { code: string }).code, detail: (event as { detail: string }).detail } };
    default:
      return turn;
  }
}

type ToolResult = NonNullable<Entry["toolResults"]>[number];

/** Every tool result the entries carry, by the id of the call it answers. */
export function toolResultsById(entries: readonly Entry[]): ReadonlyMap<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const entry of entries) for (const result of entry.toolResults ?? []) results.set(result.id, result);
  return results;
}

/**
 * The entries grouped as messages are drawn: a user entry alone, and each run of
 * consecutive assistant entries as one reply — a tool-using reply is stored as
 * an entry holding the calls, one per result and one holding the answer.
 */
export function transcriptMessages(entries: readonly Entry[]): Entry[][] {
  const messages: Entry[][] = [];
  for (const entry of entries) {
    const last = messages[messages.length - 1];
    if (entry.role === "assistant" && last?.[0].role === "assistant") last.push(entry);
    else messages.push([entry]);
  }
  return messages;
}

/** The token counts of a message's entries together; none when no entry carries any. */
export const messageUsage = (message: readonly Entry[]): Usage | undefined =>
  message.reduce<Usage | undefined>((total, entry) => (entry.usage ? addUsage(total, entry.usage) : total), undefined);

/** A stored entry as blocks: its parts, then its tool calls with what they answered, found on the entry or in `results`. */
export function entryBlocks(entry: Entry, results?: ReadonlyMap<string, ToolResult>): Block[] {
  const blocks: Block[] = [];
  for (const part of entry.parts) {
    if (part.type === "text" || part.type === "reasoning") blocks.push({ kind: part.type, text: (part as { text: string }).text });
    else blocks.push({ kind: "part", part });
  }
  for (const call of entry.toolCalls ?? []) {
    const answer = entry.toolResults?.find((result) => result.id === call.id) ?? results?.get(call.id);
    blocks.push({
      kind: "tool",
      id: call.id,
      name: call.name,
      written: "",
      arguments: call.arguments,
      done: answer !== undefined,
      ...(answer ? { result: answer.result, isError: answer.isError === true } : {}),
    });
    if (call.approval) {
      blocks.push({
        kind: "approval",
        id: call.approval.id,
        name: call.name,
        arguments: call.arguments,
        ...(call.approval.decision ? { decision: call.approval.decision } : {}),
        sent: call.approval.decision !== null,
      });
    }
  }
  return blocks;
}

/** The text of a message as a person copies it. */
export const messageText = (blocks: readonly Block[]): string =>
  blocks
    .filter((block): block is Extract<Block, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");

/** The attachment id an attachment URL names: the last segment of `GET /conversations/<id>/attachments/<id>`. */
export const attachmentId = (url: string): string => decodeURIComponent(new URL(url, "http://telo.invalid").pathname.split("/").filter(Boolean).pop() ?? "");

/** The ids of the attachments an entry carries, in order. */
export const entryAttachments = (entry: Entry): string[] =>
  entry.parts.filter((part) => ["image", "audio", "video", "file"].includes(part.type)).map((part) => attachmentId((part as { url: string }).url));

/**
 * The address a media part's URL names. The endpoint answers an attachment by a
 * reference relative to its own base (`conversations/cnv_…/attachments/att_…`), which resolves under
 * the source's `basePath`; a rooted path or one with a scheme is already an address.
 */
export const attachmentAddress = (basePath: string, url: string): string =>
  url.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ? url : `${basePath.replace(/\/+$/, "")}/${url}`;

/** The name a media part is shown by. */
export const partName = (part: { name?: string; url: string }): string => part.name ?? attachmentId(part.url);

/** A conversation as Markdown, for export: its messages from the root, as drawn. */
export function transcriptMarkdown(entries: readonly Entry[], labels: { user: string; assistant: string }, basePath: string): string {
  const results = toolResultsById(entries);
  const sections = transcriptMessages(entries).map((message) => {
    const body = message
      .flatMap((entry) => entryBlocks(entry, results))
      .map((block) => {
        if (block.kind === "text") return block.text;
        if (block.kind === "tool") return `\`\`\`json\n${JSON.stringify({ tool: block.name, arguments: block.arguments, result: block.result }, null, 2)}\n\`\`\``;
        if (block.kind === "part" && "url" in block.part) {
          const part = block.part as { url: string; name?: string; type: string };
          const address = attachmentAddress(basePath, part.url);
          return part.type === "image" ? `![${partName(part)}](${address})` : `[${partName(part)}](${address})`;
        }
        return "";
      })
      .filter((each) => each !== "")
      .join("\n\n");
    return `## ${labels[message[0].role]}\n\n${body}`;
  });
  return `${sections.join("\n\n")}\n`;
}
