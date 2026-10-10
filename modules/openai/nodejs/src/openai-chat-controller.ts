import { randomUUID } from "node:crypto";
import {
  contentToText,
  isMediaPart,
  type ContentPart,
  type MediaPart,
  type MessageContent,
} from "@telorun/ai";
import { modelResponseInvalid } from "@telorun/ai";
import type {
  AiModelInstance,
  AiModelStreamInstance,
  CompletionResult,
  ModelStreamResult,
  FinishReason,
  Message,
  ModelInvokeInput,
  StreamPart,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@telorun/ai";
import type {
  ControllerContext,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { Stream } from "@telorun/sdk";
import { mergeOptions, toChatResponseFormat, toOpenAiParams } from "./openai-params.js";
import {
  isRecord,
  numberLeaf,
  objectList,
  objectMember,
  textLeaf,
  type Members,
} from "./openai-answer-shape.js";
import {
  readingParts,
  building,
  callLabel,
  callOpenAi,
  openOpenAiStream,
  reading,
  type HttpRequestInstance,
} from "./openai-endpoint.js";
import { reportedFailure, vendorErrorOf } from "./openai-failure.js";
import { parseFrame, parseSseData } from "./openai-sse.js";
import {
  contentUnsupported,
  dataUrl,
  namedFileData,
  OUTPUT_ONLY,
  parseToolArguments,
  remoteUrl,
  toolArgumentsText,
} from "./openai-message-parts.js";

/**
 * OpenAI-compatible provider for the Ai.Model abstract. Speaks the OpenAI
 * `/chat/completions` HTTP API directly (no vendor SDK), so the same controller
 * serves OpenAI plus every OpenAI-compatible endpoint (Azure OpenAI, Ollama,
 * vLLM, Groq, Together, OpenRouter, …) via the client's `baseUrl`.
 *
 * TWO kinds, because Ai.Model and Ai.ModelStream are two abstracts with one
 * declared entry point each. They share this file — and their request building
 * — so the translation cannot drift between them; what differs is only how the
 * response is read.
 *
 * Options merging: provider-hardcoded defaults (none) → this manifest's
 * `options` → caller-supplied options (pre-merged by Ai.Text / Ai.TextStream).
 * Shallow merge, downstream wins. Option keys are native OpenAI request
 * parameters (`temperature`, `max_tokens`, `top_p`, …) merged into the request
 * body verbatim.
 */

interface OpenaiResource {
  metadata: { name: string; module?: string };
  model: string;
  /** Injected by Phase 5 — the account's base URL and credential live on its
   *  client, so this module holds no key. */
  request: HttpRequestInstance;
  options?: Record<string, unknown>;
}

// --- OpenAI wire shapes ---

/** A tool call as this controller SENDS one back in an assistant message. What
 *  the endpoint answers with is read member by member, as untrusted. */
interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

const OPENAI_FINISH_TO_AI: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
};

function mapFinishReason(reason: unknown): FinishReason {
  const said = textLeaf(reason);
  if (!said) return "other";
  return OPENAI_FINISH_TO_AI[said] ?? "other";
}

/** The two breakdowns are carried only when the endpoint reports them: absent
 *  means "not said", which a compatible endpoint that omits the detail objects
 *  must not have turned into a zero. A figure that is not a number says nothing. */
function mapUsage(reported: unknown): Usage {
  const usage = isRecord(reported) ? reported : {};
  const details = (member: string): Members =>
    isRecord(usage[member]) ? (usage[member] as Members) : {};
  const cached = numberLeaf(details("prompt_tokens_details").cached_tokens);
  const reasoning = numberLeaf(details("completion_tokens_details").reasoning_tokens);
  return {
    promptTokens: numberLeaf(usage.prompt_tokens) ?? 0,
    completionTokens: numberLeaf(usage.completion_tokens) ?? 0,
    totalTokens: numberLeaf(usage.total_tokens) ?? 0,
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

type OpenAiRequestMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const TAKES_IMAGE = "This endpoint takes an image as bytes or by an http(s) URL.";
const TAKES_FILE =
  "This endpoint takes a file as bytes only; the responses API also takes one by an http(s) URL.";

/** What a tool message says when its real answer is media. This dialect's tool
 *  message is text only, so the media rides a synthetic `user` message flushed
 *  AFTER the whole run of tool results, never between them. Interleaving tool
 *  and user messages is a 400. */
const TOOL_MEDIA_PLACEHOLDER = "(tool returned media content — see the following message)";

function mediaParts(content: MessageContent): MediaPart[] {
  if (typeof content === "string") return [];
  return content.filter(isMediaPart);
}
const TAKES_MEDIA = "This endpoint takes text, images and files.";

/**
 * One content part on this dialect's wire, or the refusal of one it cannot
 * carry: an image goes by bytes or by URL, a file by bytes under its name, and audio,
 * video and every part a model produces not at all. Refused rather than
 * dropped — dropping it would send a request quietly missing part of the
 * message.
 */
function translatePart(part: ContentPart, label: string): OpenAiContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: part.uri === undefined ? dataUrl(part) : remoteUrl(part, label, TAKES_IMAGE),
        },
      };
    case "file":
      if (part.uri !== undefined) {
        // A scheme the endpoint could never be handed is the more specific reason.
        remoteUrl(part, label, TAKES_FILE);
        throw contentUnsupported(label, part, TAKES_FILE);
      }
      return { type: "file", file: namedFileData(part, label) };
    case "audio":
    case "video":
      throw contentUnsupported(label, part, TAKES_MEDIA);
    default:
      throw contentUnsupported(label, part, OUTPUT_ONLY);
  }
}

/** Translate message content for a role that can carry parts (user). A plain
 *  string passes through; content parts become the OpenAI multimodal part array. */
function translateContent(content: MessageContent, label: string): string | OpenAiContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => translatePart(part, label));
}

function translateMessages(messages: Message[], label: string): OpenAiRequestMessage[] {
  const out: OpenAiRequestMessage[] = [];
  // OpenAI requires every `tool` message answering an assistant's tool_calls to be
  // contiguous, before any other role. A media-bearing tool result can't carry the
  // media in the tool message, so it needs a synthetic `user` message — but those
  // must be buffered and flushed AFTER the whole run of tool messages, never inline,
  // or a turn with multiple media tool results interleaves tool/user/tool/user and
  // OpenAI rejects it with a 400.
  let pendingMediaMessages: OpenAiRequestMessage[] = [];
  const flushPendingMedia = () => {
    if (pendingMediaMessages.length > 0) {
      out.push(...pendingMediaMessages);
      pendingMediaMessages = [];
    }
  };

  for (const m of messages) {
    if (m.role === "tool") {
      const media = mediaParts(m.content);
      const text = contentToText(m.content);
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        // Text placeholder in the tool message; the media rides the buffered user
        // message flushed once this run of tool messages ends.
        content: media.length === 0 ? text : text || TOOL_MEDIA_PLACEHOLDER,
      });
      if (media.length > 0) {
        pendingMediaMessages.push({
          role: "user",
          content: media.map((part) => translatePart(part, label)),
        });
      }
      continue;
    }
    // Any non-tool message ends the contiguous tool run — flush buffered media
    // carriers ahead of it so they sit after the tool messages, not between them.
    flushPendingMedia();
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const text = contentToText(m.content);
      out.push({
        role: "assistant",
        content: text ? text : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      });
      continue;
    }
    if (m.role === "system") {
      // System messages don't carry images; flatten any parts to their text.
      out.push({ role: "system", content: contentToText(m.content) });
      continue;
    }
    out.push({
      role: m.role,
      content: translateContent(m.content, label),
    } as OpenAiRequestMessage);
  }
  // The conversation handed to the provider ends with the tool results of the last
  // turn, so flush any media buffered from that trailing run.
  flushPendingMedia();
  return out;
}

/** Build the OpenAI `tools` array from our model-facing tool definitions. The
 *  Ai.Agent loop executes tools itself, so we only advertise the schema — the
 *  model replies with the requested calls (finish_reason "tool_calls"). */
function buildTools(defs: ToolDefinition[] | undefined): unknown[] | undefined {
  if (!defs || defs.length === 0) return undefined;
  return defs.map((d) => ({
    type: "function",
    function: {
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      parameters: d.parameters,
    },
  }));
}

const TOOL_CALLS = "choices[0].message.tool_calls";

/** The calls a buffered answer asks for. Each names its function in an object
 *  of its own; a call without one cannot be read. */
function parseToolCalls(given: unknown, label: string): ToolCall[] {
  return (objectList(given, TOOL_CALLS, label) ?? []).map((call) => {
    const fn = objectMember(call.function, `${TOOL_CALLS}[].function`, label);
    if (!fn) {
      throw modelResponseInvalid(
        `${label}: the endpoint sent a tool call with no '${TOOL_CALLS}[].function'.`,
      );
    }
    const name = textLeaf(fn.name) ?? "";
    return {
      // An id that is not text is read as one the endpoint never sent.
      id: textLeaf(call.id) as string,
      name,
      arguments: parseToolArguments(fn.arguments, name || "(unnamed)"),
    };
  });
}

/** A buffered answer. One with no message is not an empty answer: reporting it
 *  as one would hand the caller blank text under a clean finish. */
function readCompletion(data: Members, label: string): CompletionResult {
  const choice = objectList(data.choices, "choices", label)?.[0];
  const message = objectMember(choice?.message, "choices[0].message", label);
  if (!choice || !message) {
    throw modelResponseInvalid(
      `${label}: the endpoint's answer carries no 'choices[0].message'.`,
    );
  }
  const toolCalls = parseToolCalls(message.tool_calls, label);
  const text = textLeaf(message.content) ?? "";
  return {
    // The parts are the whole answer; `text` is their text concatenated,
    // carried beside them because that is what most consumers want.
    content: text === "" ? [] : [{ type: "text", text }],
    text,
    usage: mapUsage(data.usage),
    finishReason: mapFinishReason(choice.finish_reason),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** What the two kinds share: the endpoint, the request translation, and the
 *  redacted snapshot. */
abstract class OpenaiBase {
  constructor(protected readonly resource: OpenaiResource) {}

  /** No redaction needed: the key is the client's, and a credential's own
   *  output is marked `x-telo-sensitive`. */
  snapshot(): Record<string, unknown> {
    return {
      model: this.resource.model,
      ...(this.resource.options ? { options: this.resource.options } : {}),
    };
  }

  protected buildBody(input: ModelInvokeInput, stream: boolean): Record<string, unknown> {
    const tools = buildTools(input.tools);
    const body: Record<string, unknown> = {
      model: this.resource.model,
      messages: translateMessages(
        input.messages,
        `OpenAI chat completion "${this.resource.metadata.name}"`,
      ),
      ...(tools ? { tools } : {}),
      // A declared contract input, under this dialect's own key AND its own
      // shape: a `json_schema` format is nested here and flat on the responses
      // API, and each refuses the other's form outright.
      ...(input.responseFormat
        ? { response_format: toChatResponseFormat(input.responseFormat) }
        : {}),
      ...toOpenAiParams(mergeOptions(this.resource.options, input.options)),
      // The contract's own switch, after the options so it is what the call
      // says: `none` keeps the tools declared — the conversation's earlier calls
      // stay valid — and forbids a new one.
      ...(tools && input.toolChoice ? { tool_choice: input.toolChoice } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    return body;
  }

}

class OpenaiModelInstance extends OpenaiBase implements ResourceInstance, AiModelInstance {
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult> {
    const operation = "OpenAI chat completion";
    const label = callLabel(operation, this.resource.metadata.name);
    const body = building(label, ctx, () => this.buildBody(input, false));
    const data = await callOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      operation,
      { path: "/chat/completions", body },
      ctx,
    );
    return reading(label, ctx, () => readCompletion(data, label));
  }
}

class OpenaiModelStreamInstance
  extends OpenaiBase
  implements ResourceInstance, AiModelStreamInstance
{
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<ModelStreamResult> {
    // Built here rather than when the stream is first read: a part this dialect
    // cannot carry fails the CALL, and only the endpoint's own failures reject
    // the iteration.
    const operation = callLabel("OpenAI chat stream", this.resource.metadata.name);
    const body = building(operation, ctx, () => this.buildBody(input, true));
    return { output: new Stream(this.parts(body, operation, ctx)) };
  }

  private async *parts(
    requestBody: Record<string, unknown>,
    operation: string,
    ctx?: InvokeContext,
  ): AsyncIterable<StreamPart> {
    // A refused request FAILS — the status is judged at the endpoint boundary,
    // which reads the vendor's own error out of the body. The parts already
    // emitted still reach the consumer when a failure comes later.
    const body = await openOpenAiStream(
      this.resource.request,
      this.resource.metadata.name,
      "OpenAI chat stream",
      { path: "/chat/completions", body: requestBody },
      ctx,
    );
    yield* readingParts(operation, ctx, this.read(body, operation, ctx));
  }

  private async *read(
    body: AsyncIterable<Uint8Array>,
    operation: string,
    ctx?: InvokeContext,
  ): AsyncGenerator<StreamPart> {
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // What the endpoint said ended the answer. A stream that reaches `[DONE]`
    // without saying finishes `other`, never `stop`: nothing declared it a
    // clean stop.
    let finishReason: FinishReason | undefined;
    let done = false;
    // Tool calls arrive as fragments across chunks keyed by index; accumulate id,
    // name, and the concatenated arguments string, then assemble at the finish
    // boundary (arguments are only valid JSON once fully joined). `held` is the
    // argument text not yet reported as a delta: nothing is reported for a
    // call before its id and name are known.
    // A compatible endpoint may leave the index out; such fragments are one call.
    const toolAcc = new Map<number | undefined, StreamedToolCall>();
    for await (const data of parseSseData(body, operation, ctx)) {
      if (data === "[DONE]") {
        done = true;
        break;
      }
      const chunk = parseFrame(data, operation);
      // A failure reported inside the stream wins over anything beside it.
      const failed = vendorErrorOf(chunk);
      if (failed) throw reportedFailure(operation, "the endpoint failed mid-stream", failed);
      const choice = objectList(chunk.choices, "choices", operation)?.[0];
      const delta = objectMember(choice?.delta, "choices[0].delta", operation);
      const content = textLeaf(delta?.content);
      if (content) yield { type: "text-delta", delta: content };
      // A fragment of a tool call: the first carries the id and the function's
      // name, later ones append to its arguments. The id may come late, or never.
      for (const tc of objectList(delta?.tool_calls, DELTA_TOOL_CALLS, operation) ?? []) {
        const fn = objectMember(tc.function, `${DELTA_TOOL_CALLS}[].function`, operation);
        const index = numberLeaf(tc.index);
        const entry = toolAcc.get(index) ?? { id: "", name: "", args: "", held: "" };
        entry.id = textLeaf(tc.id) || entry.id;
        entry.name = textLeaf(fn?.name) || entry.name;
        const fragment = toolArgumentsText(fn?.arguments, entry.name || "(unnamed)");
        if (fragment) {
          entry.args += fragment;
          entry.held += fragment;
        }
        toolAcc.set(index, entry);
        if (entry.id && entry.name) yield* releaseHeld(entry);
      }
      if (textLeaf(choice?.finish_reason)) finishReason = mapFinishReason(choice?.finish_reason);
      if (isRecord(chunk.usage)) usage = mapUsage(chunk.usage);
    }
    // The bytes ran out with neither a finish reason nor the end sentinel — a
    // cut connection, a proxy that closed. Reporting `finish` here would render
    // an interrupted answer as a clean stop.
    if (!done && finishReason === undefined) {
      throw modelResponseInvalid(
        `${operation}: the stream ended without a finish reason or '[DONE]', so the answer is incomplete.`,
      );
    }
    // Emit one assembled tool-call part per accumulated index, in index order,
    // before the terminal finish. A call the endpoint never named gets an id
    // minted here — unique, where a positional one would repeat on the next
    // model call of the same run — and whatever is still held goes out under
    // it, immediately ahead of the call.
    for (const [, entry] of [...toolAcc.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
      entry.id ||= `call_${randomUUID()}`;
      yield* releaseHeld(entry);
      yield {
        type: "tool-call",
        toolCall: {
          id: entry.id,
          name: entry.name,
          arguments: parseToolArguments(entry.args, entry.name),
        },
      };
    }
    yield { type: "finish", usage, finishReason: finishReason ?? "other" };
  }
}

const DELTA_TOOL_CALLS = "choices[0].delta.tool_calls";

/** One streamed call being assembled. */
interface StreamedToolCall {
  id: string;
  name: string;
  /** Every argument fragment so far, joined. */
  args: string;
  /** The part of `args` not yet reported as a delta. */
  held: string;
}

/** Report the argument text a call is holding, under the id it now has. */
function* releaseHeld(entry: StreamedToolCall): Generator<StreamPart> {
  if (entry.held === "") return;
  const delta = entry.held;
  entry.held = "";
  yield { type: "tool-call-delta", toolCallId: entry.id, toolName: entry.name, delta };
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiResource,
  _ctx: ResourceContext,
): Promise<OpenaiModelInstance> {
  return new OpenaiModelInstance(resource);
}

export async function createStream(
  resource: OpenaiResource,
  _ctx: ResourceContext,
): Promise<OpenaiModelStreamInstance> {
  return new OpenaiModelStreamInstance(resource);
}

