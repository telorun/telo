import type { InvokeContext, OpenSpan, ResourceContext } from "@telorun/sdk";
import { errorTypeOf, getRefIdentity, isCancellationError, isInvokeError, isSuspension } from "@telorun/sdk";
import type { FinishReason, Usage } from "./types.js";

/**
 * The spans an agent run opens — `invoke_agent <name>` over the whole run,
 * `chat <model>` per model call, `execute_tool <name>` per tool call — named and
 * attributed after the OpenTelemetry GenAI conventions. Never message content:
 * prompts, completions and tool arguments are the user's data, and a trace
 * backend is not where they belong.
 *
 * Opened through `ctx.openSpan`, so they cost nothing while tracing is off, and
 * each nests under the span of the context it is opened on.
 */

/** What an agent needs of its context to open spans. */
export type SpanOpener = Pick<ResourceContext, "openSpan">;

export interface AgentSpanIdentity {
  /** The agent's kind, as the span's `ref`. */
  kind: string;
  /** The agent resource's name. */
  name: string;
}

export function openAgentSpan(
  ctx: SpanOpener,
  base: InvokeContext | undefined,
  agent: AgentSpanIdentity,
): Promise<OpenSpan> {
  return ctx.openSpan(base, {
    ref: agent,
    label: `invoke_agent ${agent.name}`,
    attributes: { "gen_ai.operation.name": "invoke_agent" },
  });
}

export function openChatSpan(
  ctx: SpanOpener,
  agentSpan: OpenSpan,
  agent: AgentSpanIdentity,
  model: string,
): Promise<OpenSpan> {
  return ctx.openSpan(agentSpan.context, {
    ref: agent,
    label: `chat ${model}`,
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": model },
  });
}

export function openToolSpan(
  ctx: SpanOpener,
  base: InvokeContext | undefined,
  agent: AgentSpanIdentity,
  tool: { name: string; callId: string },
): Promise<OpenSpan> {
  return ctx.openSpan(base, {
    ref: agent,
    label: `execute_tool ${tool.name}`,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": tool.name,
      "gen_ai.tool.call.id": tool.callId,
    },
  });
}

/** What a finished model call adds to its `chat` span. */
export function chatAttributes(usage: Usage, finishReason: FinishReason): Record<string, unknown> {
  return {
    ...usageAttributes(usage),
    "gen_ai.response.finish_reasons": [finishReason],
  };
}

export function usageAttributes(usage: Usage): Record<string, unknown> {
  return {
    "gen_ai.usage.input_tokens": usage.promptTokens,
    "gen_ai.usage.output_tokens": usage.completionTokens,
  };
}

/**
 * The model a `chat` span names: the model resource's published `model` field
 * (the provider's model id — every standard provider publishes it), else the
 * resource's own name, which is what the manifest calls it.
 */
export function modelNameOf(model: unknown): string {
  if (model && typeof model === "object") {
    const snapshot = (model as { snapshot?: () => unknown }).snapshot;
    if (typeof snapshot === "function") {
      const published = (snapshot.call(model) as { model?: unknown } | undefined)?.model;
      if (typeof published === "string" && published.length > 0) return published;
    }
    const identity = getRefIdentity(model as object);
    if (identity?.name) return identity.name;
  }
  return "model";
}

/** Close `span` for a failure: a cancellation and a suspension are outcomes of
 *  their own, a coded error is a rejection, anything else a failure. */
export function settleFailure(
  span: OpenSpan,
  err: unknown,
  attributes: Record<string, unknown> = {},
): Promise<void> {
  if (isCancellationError(err)) {
    return span.settle("cancelled", {
      attributes: {
        ...attributes,
        "telo.cancellation.reason": err instanceof Error ? err.message : String(err),
      },
    });
  }
  if (isSuspension(err)) return span.settle("parked", { attributes });
  if (isInvokeError(err)) {
    return span.settle("rejected", { attributes: { ...attributes, "error.type": err.code } });
  }
  return span.settle("failed", { attributes: { ...attributes, "error.type": errorTypeOf(err) } });
}
