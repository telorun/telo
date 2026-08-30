import { contentToText, isImagePart, type ImagePart, type MessageContent } from "@telorun/ai";
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
import { InvokeError, Stream } from "@telorun/sdk";
import { mergeOptions, toOpenAiParams } from "./openai-params.js";
import { callOpenAi, type HttpRequestInstance } from "./openai-endpoint.js";

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

// --- OpenAI wire shapes (only the fields this controller reads) ---

interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
}

/** A tool-call fragment in a streaming `delta`. OpenAI splits one tool call across
 *  many chunks keyed by `index`: the first carries `id` and `function.name`, later
 *  ones append `function.arguments` string fragments. */
interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: OpenAiToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
}

const OPENAI_FINISH_TO_AI: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
};

function mapFinishReason(fr: string | null | undefined): FinishReason {
  if (!fr) return "other";
  return OPENAI_FINISH_TO_AI[fr] ?? "other";
}

function mapUsage(u: OpenAiUsage | undefined): Usage {
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
  };
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAiRequestMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Render an image part as an OpenAI data URL. Runtime tool results carry raw bytes
 *  (the stdlib binary convention); manifest-authored parts carry a base64 string. */
function imageDataUrl(part: ImagePart): string {
  const base64 =
    typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  return `data:${part.mediaType};base64,${base64}`;
}

function toImageUrlPart(part: ImagePart): OpenAiContentPart {
  return { type: "image_url", image_url: { url: imageDataUrl(part) } };
}

function imageParts(content: MessageContent): ImagePart[] {
  if (typeof content === "string") return [];
  return content.filter(isImagePart);
}

/** Translate message content for a role that can carry images (user). A plain string
 *  passes through; content parts become the OpenAI multimodal part array.
 *
 *  The part vocabulary is wider than this dialect can SEND — `reasoning`,
 *  `citation` and the rest are things a model produces, not things a caller
 *  submits. One that reaches here is refused rather than dropped: dropping it
 *  would send a request quietly missing part of the message. */
function translateContent(content: MessageContent, resourceName: string): string | OpenAiContentPart[] {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "image") return toImageUrlPart(p);
    if (p.type === "text") return { type: "text", text: p.text } as OpenAiContentPart;
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `OpenAI chat completion "${resourceName}": a '${p.type}' content part cannot be sent ` +
        `on the chat dialect — it is produced by a model, not submitted to one.`,
    );
  });
}

function translateMessages(messages: Message[], resourceName: string): OpenAiRequestMessage[] {
  const out: OpenAiRequestMessage[] = [];
  // OpenAI requires every `tool` message answering an assistant's tool_calls to be
  // contiguous, before any other role. An image-bearing tool result can't carry the
  // image in the tool message, so it needs a synthetic `user` message — but those
  // must be buffered and flushed AFTER the whole run of tool messages, never inline,
  // or a turn with multiple image tool results interleaves tool/user/tool/user and
  // OpenAI rejects it with a 400.
  let pendingImageMessages: OpenAiRequestMessage[] = [];
  const flushPendingImages = () => {
    if (pendingImageMessages.length > 0) {
      out.push(...pendingImageMessages);
      pendingImageMessages = [];
    }
  };

  for (const m of messages) {
    if (m.role === "tool") {
      const images = imageParts(m.content);
      const text = contentToText(m.content);
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        // Text placeholder in the tool message; the image rides the buffered user
        // message flushed once this run of tool messages ends.
        content:
          images.length === 0
            ? text
            : text || "(tool returned image content — see the following message)",
      });
      if (images.length > 0) {
        pendingImageMessages.push({ role: "user", content: images.map(toImageUrlPart) });
      }
      continue;
    }
    // Any non-tool message ends the contiguous tool run — flush buffered image
    // carriers ahead of it so they sit after the tool messages, not between them.
    flushPendingImages();
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
      content: translateContent(m.content, resourceName),
    } as OpenAiRequestMessage);
  }
  // The conversation handed to the provider ends with the tool results of the last
  // turn, so flush any images buffered from that trailing run.
  flushPendingImages();
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

function parseToolCalls(tcs: OpenAiToolCall[] | undefined): ToolCall[] {
  if (!tcs || tcs.length === 0) return [];
  return tcs.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: parseToolArguments(tc.function.arguments, tc.function.name),
  }));
}

/** OpenAI returns tool-call arguments as a JSON string. Parse it into the object
 *  shape the Ai contract requires; surface malformed JSON rather than hiding it
 *  behind an empty object (an empty-args call and a broken-args call differ). */
function parseToolArguments(raw: string | undefined, toolName: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI tool call '${toolName}' returned non-JSON arguments: ${raw}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenAI tool call '${toolName}' arguments were not a JSON object: ${raw}`);
  }
  return parsed as Record<string, unknown>;
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
      messages: translateMessages(input.messages, this.resource.metadata.name),
      ...(tools ? { tools } : {}),
      ...toOpenAiParams(mergeOptions(this.resource.options, input.options)),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    return body;
  }

}

class OpenaiModelInstance extends OpenaiBase implements ResourceInstance, AiModelInstance {
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult> {
    const data = (await callOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      "OpenAI chat completion",
      { path: "/chat/completions", body: this.buildBody(input, false) },
      ctx,
    )) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    const text = choice?.message?.content ?? "";
    return {
      // The parts are the whole answer; `text` is their text concatenated,
      // carried beside them because that is what most consumers want.
      content: text === "" ? [] : [{ type: "text", text }],
      text,
      usage: mapUsage(data.usage),
      finishReason: mapFinishReason(choice?.finish_reason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

class OpenaiModelStreamInstance
  extends OpenaiBase
  implements ResourceInstance, AiModelStreamInstance
{
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<ModelStreamResult> {
    return { output: new Stream(this.parts(input, ctx)) };
  }

  private async *parts(input: ModelInvokeInput, ctx?: InvokeContext): AsyncIterable<StreamPart> {
      // A refused request FAILS — the status check lives in `callOpenAi`, which
      // reads the provider's own message out of the body. The parts already
      // emitted still reach the consumer when a failure comes later.
      const body = await callOpenAi(
        this.resource.request,
        this.resource.metadata.name,
        "OpenAI chat stream",
        { path: "/chat/completions", body: this.buildBody(input, true), stream: true },
        ctx,
      );

      let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason: FinishReason = "stop";
      // Tool calls arrive as fragments across chunks keyed by index; accumulate id,
      // name, and the concatenated arguments string, then assemble at the finish
      // boundary (arguments are only valid JSON once fully joined).
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      for await (const data of parseSseData(body as AsyncIterable<Uint8Array>)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as OpenAiStreamChunk;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: "text-delta", delta: choice.delta.content };
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const entry = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolAcc.set(tc.index, entry);
        }
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        if (chunk.usage) usage = mapUsage(chunk.usage);
      }
      // Emit one assembled tool-call part per accumulated index, in index order,
      // before the terminal finish.
      for (const [index, entry] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          type: "tool-call",
          toolCall: {
            id: entry.id || `call_${index}`,
            name: entry.name,
            arguments: parseToolArguments(entry.args, entry.name),
          },
        };
      }
    yield { type: "finish", usage, finishReason };
  }
}

/** Parse an OpenAI SSE byte stream into the payload of each `data:` line. Handles
 *  chunk boundaries that split a line and a final unterminated line.
 *
 *  Takes an async iterable rather than a web `ReadableStream`: the bytes now
 *  arrive from `Http.Request`'s streamed response, which is also what makes a
 *  consumer's early exit reach the transport — breaking out of this loop returns
 *  the source iterator, and the request controller aborts on that. */
async function* parseSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const data = sseDataPayload(line);
      if (data !== null) yield data;
    }
  }
  buffer += decoder.decode();
  const tail = sseDataPayload(buffer);
  if (tail !== null) yield tail;
}

/** Return the payload of a `data:` SSE line, or null for blank / comment / other
 *  field lines. */
function sseDataPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice("data:".length).trim();
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

