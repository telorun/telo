import { randomUUID } from "node:crypto";
import {
  modelResponseInvalid,
  modelToolArgumentsInvalid,
  type CompletionResult,
  type ContentPart,
  type FinishReason,
  type ToolCall,
  type Usage,
} from "@telorun/ai";
import {
  qualifiedName,
  type Block,
  type MessagesProviderState,
  type MessagesResource,
} from "./messages-request.js";

/**
 * A Messages API answer as the model contract's result. The readers of one
 * block, of the usage figures and of the stop reason are separate so that an
 * answer arriving in pieces is read by the same rules as one arriving whole.
 */

/** The usage figures the API reports (only the ones read here). */
export interface MessagesUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const count = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * The API reports its input in three separate figures — uncached, read from a
 * cache, written to one — where the contract's `promptTokens` is the whole
 * prompt, so they are added. The two cache shares are carried only when the
 * endpoint reports them: absent means "not said", which is not zero.
 */
export function mapUsage(usage: MessagesUsage | undefined): Usage {
  const cached = usage?.cache_read_input_tokens;
  const written = usage?.cache_creation_input_tokens;
  const promptTokens = count(usage?.input_tokens) + count(cached) + count(written);
  const completionTokens = count(usage?.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(typeof cached === "number" ? { cachedPromptTokens: cached } : {}),
    ...(typeof written === "number" ? { cacheWritePromptTokens: written } : {}),
  };
}

/** Why the turn ended. A refusal is an answer, reported as its reason — the
 *  call did not fail. */
export function mapFinishReason(stopReason: unknown): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "refusal":
      return "content-filter";
    default:
      return "other";
  }
}

/**
 * A block as it is first read, with a tool call named. The id is the
 * endpoint's own when it gives a non-empty one; otherwise one is minted and
 * written INTO the block, so the call, its argument deltas and the state
 * carried to the next request all hold the same id. An empty id would tie no
 * tool result to its call, and a positional one repeats on the next model call.
 */
export function namedBlock(block: Block): Block {
  if (block.type !== "tool_use") return block;
  if (typeof block.id === "string" && block.id !== "") return block;
  return { ...block, id: `call_${randomUUID()}` };
}

/** The call a `tool_use` block asks for. Its input is an object by the API's
 *  own contract; anything else is raised rather than run as empty arguments. */
export function toolCallOf(block: Block, label: string): ToolCall {
  const name = typeof block.name === "string" ? block.name : "";
  const input = block.input ?? {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw modelToolArgumentsInvalid(
      `${label}: the model asked for tool '${name || "(unnamed)"}' with arguments that are not ` +
        `a JSON object: ${JSON.stringify(input)}`,
      { tool: name || "(unnamed)" },
    );
  }
  return {
    id: typeof block.id === "string" ? block.id : "",
    name,
    arguments: input as Record<string, unknown>,
  };
}

/** What a block shows a reader, when it shows anything: an answer's text, or
 *  the model's thinking. */
export function contentPartOf(block: Block): ContentPart | undefined {
  if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
    return { type: "reasoning", text: block.thinking };
  }
  return undefined;
}

/**
 * An answer's blocks as the state to carry to the next request — only when
 * they hold something the contract's own fields cannot rebuild: a thinking
 * block and its signature, a redacted one, a block of a kind this module does
 * not read. An answer of text and tool calls alone needs none.
 */
export function providerStateOf(
  blocks: Block[],
  resource: MessagesResource,
): MessagesProviderState | undefined {
  if (blocks.every((block) => block.type === "text" || block.type === "tool_use")) return undefined;
  return {
    api: "messages",
    model: resource.model,
    resource: qualifiedName(resource),
    content: blocks,
  };
}

const isBlock = (value: unknown): value is Block =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A buffered answer. One with no `content` list is not an empty answer. */
export function readAnswer(
  data: Record<string, unknown>,
  resource: MessagesResource,
  label: string,
): CompletionResult {
  if (!Array.isArray(data.content) || !data.content.every(isBlock)) {
    throw modelResponseInvalid(`${label}: the endpoint's answer carries no 'content' list.`);
  }
  const blocks: Block[] = data.content.map(namedBlock);
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  let text = "";
  for (const block of blocks) {
    if (block.type === "tool_use") {
      toolCalls.push(toolCallOf(block, label));
      continue;
    }
    const part = contentPartOf(block);
    if (!part) continue;
    content.push(part);
    if (part.type === "text") text += part.text;
  }
  const state = providerStateOf(blocks, resource);
  return {
    content,
    text,
    usage: mapUsage(data.usage as MessagesUsage | undefined),
    finishReason: mapFinishReason(data.stop_reason),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(state ? { providerState: state } : {}),
  };
}
