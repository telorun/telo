import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { redact } from "@telorun/ai/redact";
import type {
  AiModelInstance,
  CompletionResult,
  FinishReason,
  Message,
  ModelInvokeInput,
  StreamPart,
  Usage,
} from "@telorun/ai/types";
import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

/**
 * OpenAI provider for the Ai.Model abstract. Implements the full AiModelInstance
 * contract — `invoke` (via Vercel AI SDK's generateText) and `stream` (via streamText).
 *
 * Options merging: provider-hardcoded defaults (none — we defer to the SDK's defaults)
 * → Ai.OpenaiModel.options (this manifest's field, merged here) → caller-supplied options
 * (already pre-merged by Ai.Completion before it reaches `invoke`/`stream`). Shallow merge,
 * downstream wins.
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
  "tool-calls": "other",
  error: "error",
  other: "other",
  unknown: "other",
};

function mapFinishReason(fr: string | undefined | null): FinishReason {
  if (!fr) return "other";
  return VERCEL_FINISH_TO_AI[fr] ?? "other";
}

function mapUsage(u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined): Usage {
  return {
    promptTokens: u?.inputTokens ?? 0,
    completionTokens: u?.outputTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
  };
}

function translateMessages(messages: Message[]): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  // OpenAI (via Vercel AI SDK) accepts system messages inline — pass through.
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

class OpenaiModelInstance implements ResourceInstance, AiModelInstance {
  private readonly client: ReturnType<typeof createOpenAI>;

  constructor(private readonly resource: OpenaiResource) {
    this.client = createOpenAI({
      apiKey: resource.apiKey,
      ...(resource.baseUrl ? { baseURL: resource.baseUrl } : {}),
    });
  }

  async invoke({ messages, options }: ModelInvokeInput): Promise<CompletionResult> {
    const merged = mergeOptions(this.resource.options, options);
    const result = await generateText({
      model: this.client(this.resource.model),
      messages: translateMessages(messages),
      ...merged,
    } as Parameters<typeof generateText>[0]);

    return {
      text: result.text,
      usage: mapUsage(result.usage as any),
      finishReason: mapFinishReason(result.finishReason as any),
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
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: "error", error };
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
