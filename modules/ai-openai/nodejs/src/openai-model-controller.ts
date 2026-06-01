import { createOpenAI } from "@ai-sdk/openai";
import { redact } from "@telorun/ai/redact";
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
import { generateText, jsonSchema, type ModelMessage, streamText, tool } from "ai";

// Silence the Vercel AI SDK's `AI SDK Warning: …` console output. The SDK
// emits these for things like `temperature` being ignored on reasoning
// models — useful during library development, noise for Telo manifest
// consumers who can't act on them anyway. Globally suppresses warnings
// from every Vercel-AI-SDK-backed provider, which matches the library's
// own opt-out hint (`AI_SDK_LOG_WARNINGS = false`).
globalThis.AI_SDK_LOG_WARNINGS = false;

/**
 * OpenAI provider for the Ai.Model abstract. Implements the full AiModelInstance
 * contract — `invoke` (via Vercel AI SDK's generateText) and `stream` (via streamText).
 *
 * Options merging: provider-hardcoded defaults (none — we defer to the SDK's defaults)
 * → Ai.OpenaiModel.options (this manifest's field, merged here) → caller-supplied options
 * (already pre-merged by Ai.Text / Ai.TextStream before it reaches `invoke`/`stream`).
 * Shallow merge, downstream wins.
 */
interface OpenaiResource {
  metadata: { name: string; module?: string };
  model: string;
  apiKey: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

const VERCEL_FINISH_TO_AI: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  "content-filter": "content-filter",
  "tool-calls": "tool-calls",
  error: "error",
  other: "other",
  unknown: "other",
};

function mapFinishReason(fr: string | undefined | null): FinishReason {
  if (!fr) return "other";
  return VERCEL_FINISH_TO_AI[fr] ?? "other";
}

function mapUsage(
  u:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): Usage {
  return {
    promptTokens: u?.inputTokens ?? 0,
    completionTokens: u?.outputTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
  };
}

function translateMessages(messages: Message[]): ModelMessage[] {
  // Our `tool` messages carry only { toolCallId, content }; the Vercel tool-result part
  // also needs the toolName, so recover it from the assistant tool-call turns.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) toolNameById.set(c.id, c.name);
    }
  }
  return messages.map((m): ModelMessage => {
    if (m.role === "tool") {
      const toolCallId = m.toolCallId ?? "";
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNameById.get(toolCallId) ?? "",
            output: { type: "text", value: m.content },
          },
        ],
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.arguments,
          })),
        ],
      };
    }
    // system / user / plain assistant — pass through (OpenAI accepts system inline).
    return { role: m.role, content: m.content } as ModelMessage;
  });
}

/** Build the Vercel tool set from our model-facing tool definitions. We deliberately
 *  omit `execute` — the Ai.Agent loop runs tools itself, so generateText returns the
 *  requested `toolCalls` (finishReason "tool-calls") without invoking anything. */
function buildTools(defs: ToolDefinition[] | undefined): Record<string, ReturnType<typeof tool>> | undefined {
  if (!defs || defs.length === 0) return undefined;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const d of defs) {
    tools[d.name] = tool({
      description: d.description,
      inputSchema: jsonSchema(d.parameters as Parameters<typeof jsonSchema>[0]),
    });
  }
  return tools;
}

class OpenaiModelInstance implements ResourceInstance, AiModelInstance {
  private readonly client: ReturnType<typeof createOpenAI>;

  constructor(private readonly resource: OpenaiResource) {
    this.client = createOpenAI({
      apiKey: resource.apiKey,
      ...(resource.baseUrl ? { baseURL: resource.baseUrl } : {}),
    });
  }

  async invoke({ messages, options, tools }: ModelInvokeInput): Promise<CompletionResult> {
    const merged = mergeOptions(this.resource.options, options);
    const toolSet = buildTools(tools);
    const result = await generateText({
      model: this.client(this.resource.model),
      messages: translateMessages(messages),
      ...(toolSet ? { tools: toolSet } : {}),
      ...merged,
    } as Parameters<typeof generateText>[0]);

    const toolCalls: ToolCall[] = (result.toolCalls ?? []).map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: (tc.input ?? {}) as Record<string, unknown>,
    }));

    return {
      text: result.text,
      usage: mapUsage(result.usage as any),
      finishReason: mapFinishReason(result.finishReason as any),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *stream({ messages, options }: ModelInvokeInput): AsyncIterable<StreamPart> {
    const merged = mergeOptions(this.resource.options, options);
    const result = streamText({
      model: this.client(this.resource.model),
      messages: translateMessages(messages),
      ...merged,
    } as Parameters<typeof streamText>[0]);

    try {
      for await (const delta of result.textStream) {
        if (delta) yield { type: "text-delta", delta };
      }
      const usage = await result.usage;
      const finishReason = await result.finishReason;
      yield {
        type: "finish",
        usage: mapUsage(usage as any),
        finishReason: mapFinishReason(finishReason as any),
      };
    } catch (err) {
      // Surface failure as an `error` part and terminate the iterator normally.
      // The contract (modules/ai/docs/ai-model.md) lets providers either yield an
      // error part OR throw, but not both — doing both signals failure twice and
      // breaks consumers that rely on the part-based path. We yield because it
      // preserves any already-emitted text-delta parts: SSE forwarders can flush
      // a partial response plus an error frame without losing data.
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: { message } };
    }
  }

  snapshot(): Record<string, unknown> {
    return redact(["apiKey"], this.resource);
  }
}

function mergeOptions(
  manifestOptions: Record<string, unknown> | undefined,
  callerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(manifestOptions ?? {}), ...(callerOptions ?? {}) };
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
