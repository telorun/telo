import { redact } from "@telorun/ai/redact";
import { contentToText, isImagePart, type ImagePart, type MessageContent } from "@telorun/ai/content";
import type {
  AiModelInstance,
  CompletionResult,
  FinishReason,
  Message,
  ModelInvokeInput,
  StreamPart,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@telorun/ai/types";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";

/**
 * OpenAI-compatible provider for the Ai.Model abstract. Speaks the OpenAI
 * `/chat/completions` HTTP API directly (no vendor SDK), so the same controller
 * serves OpenAI plus every OpenAI-compatible endpoint (Azure OpenAI, Ollama,
 * vLLM, Groq, Together, OpenRouter, …) via `baseUrl`. Implements the full
 * AiModelInstance contract — `invoke` (buffered) and `stream` (SSE deltas).
 *
 * Options merging: provider-hardcoded defaults (none) → this manifest's
 * `options` → caller-supplied options (pre-merged by Ai.Text / Ai.TextStream).
 * Shallow merge, downstream wins. Option keys are native OpenAI request
 * parameters (`temperature`, `max_tokens`, `top_p`, …) merged into the request
 * body verbatim.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenaiResource {
  metadata: { name: string; module?: string };
  model: string;
  apiKey: string;
  baseUrl?: string;
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

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
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
 *  passes through; content parts become the OpenAI multimodal part array. */
function translateContent(content: MessageContent): string | OpenAiContentPart[] {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "image" ? toImageUrlPart(p) : { type: "text", text: p.text },
  );
}

function translateMessages(messages: Message[]): OpenAiRequestMessage[] {
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
    out.push({ role: m.role, content: translateContent(m.content) } as OpenAiRequestMessage);
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

class OpenaiModelInstance implements ResourceInstance, AiModelInstance {
  private readonly baseUrl: string;

  constructor(private readonly resource: OpenaiResource) {
    this.baseUrl = (resource.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private buildRequest(input: ModelInvokeInput, stream: boolean): RequestInit {
    const tools = buildTools(input.tools);
    const body: Record<string, unknown> = {
      model: this.resource.model,
      messages: translateMessages(input.messages),
      ...(tools ? { tools } : {}),
      ...toOpenAiParams(mergeOptions(this.resource.options, input.options)),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.resource.apiKey) headers["authorization"] = `Bearer ${this.resource.apiKey}`;
    return {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  async invoke(input: ModelInvokeInput): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, this.buildRequest(input, false));
    if (!res.ok) throw new Error(await errorMessage(res, "OpenAI chat completion"));

    const data = (await res.json()) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    return {
      text: choice?.message?.content ?? "",
      usage: mapUsage(data.usage),
      finishReason: mapFinishReason(choice?.finish_reason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *stream(input: ModelInvokeInput): AsyncIterable<StreamPart> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, this.buildRequest(input, true));
      if (!res.ok || !res.body) {
        yield { type: "error", error: { message: await errorMessage(res, "OpenAI chat stream") } };
        return;
      }

      let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason: FinishReason = "stop";
      for await (const data of parseSseData(res.body)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as OpenAiStreamChunk;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: "text-delta", delta: choice.delta.content };
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        if (chunk.usage) usage = mapUsage(chunk.usage);
      }
      yield { type: "finish", usage, finishReason };
    } catch (err) {
      // Contract (modules/ai/docs/ai-model.md): a provider yields an error part
      // OR throws, never both. We yield so already-emitted text-delta parts
      // survive — an SSE forwarder can flush partial output plus an error frame.
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: { message } };
    }
  }

  snapshot(): Record<string, unknown> {
    return redact(["apiKey"], this.resource);
  }
}

/** Parse an OpenAI SSE byte stream into the payload of each `data:` line. Handles
 *  chunk boundaries that split a line and a final unterminated line. */
async function* parseSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const data = sseDataPayload(line);
        if (data !== null) yield data;
      }
    }
    const tail = sseDataPayload(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Return the payload of a `data:` SSE line, or null for blank / comment / other
 *  field lines. */
function sseDataPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice("data:".length).trim();
}

/** Build an actionable error message from a non-OK response, preferring the
 *  provider's `{ error: { message } }` body and falling back to the raw text. */
async function errorMessage(res: Response, label: string): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body already consumed or unavailable — status line is all we have.
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    } catch {
      // Non-JSON body (gateway HTML, plain text) — keep it verbatim.
    }
  }
  return `${label} failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`;
}

function mergeOptions(
  manifestOptions: Record<string, unknown> | undefined,
  callerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(manifestOptions ?? {}), ...(callerOptions ?? {}) };
}

/** Telo manifest props are camelCase; the OpenAI wire API is snake_case. Convert
 *  each top-level option key (`maxTokens` → `max_tokens`, `topP` → `top_p`).
 *  Only top-level keys are converted — values pass through untouched so nested
 *  structures (a `responseFormat` JSON schema, a `logitBias` token map) keep
 *  their own casing. Keys that are already snake_case are left unchanged. */
function toOpenAiParams(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    out[snakeCase(key)] = value;
  }
  return out;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiResource,
  _ctx: ResourceContext,
): Promise<OpenaiModelInstance> {
  return new OpenaiModelInstance(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
