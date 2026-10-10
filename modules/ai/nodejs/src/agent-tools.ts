import { randomUUID } from "node:crypto";
import type { InvokeContext } from "@telorun/sdk";
import {
  InvokeError,
  isCancellationError,
  isSuspension,
  toPlainJson,
  writePlainJson,
} from "@telorun/sdk";
import {
  openToolSpan,
  settleFailure,
  type AgentSpanIdentity,
  type SpanOpener,
} from "./agent-spans.js";
import { isContentPart, isContentParts, type MessageContent } from "./content.js";
import { boundToolContent } from "./tool-result-bound.js";
import type {
  AiToolProviderInstance,
  Message,
  SystemPrompt,
  ToolApproval,
  ToolCall,
  ToolDefinition,
  ToolResultRecord,
} from "./types.js";

/**
 * Shared tool-loop unit for the agents. Both `Ai.Agent` (buffered) and
 * `Ai.AgentStream` (streaming) copy the same `toolProviders` schema, so both halves
 * of the tool logic — assembly and dispatch — live here and are called by both,
 * rather than reimplemented per controller (which is exactly how they would drift).
 *
 * `dispatchToolCall` is deliberately output-neutral: it returns a `ToolResultRecord`
 * and never touches a trace or a stream. Each agent renders that record into its own
 * output — the buffered agent lists it in its `toolResults`, the streaming agent
 * emits it as a `tool-result` event.
 */
export interface ToolProviderEntry {
  /** Live Ai.ToolProvider instance after Phase 5 injection. */
  provider: AiToolProviderInstance;
  prefix?: string;
  include?: string[];
  exclude?: string[];
  /** Which of the tools this entry exposes need a decision, by bare name. */
  approval?: { include?: string[]; exclude?: string[] };
}

export interface Dispatch {
  provider: AiToolProviderInstance;
  bareName: string;
  /** The tool as the model was told it. */
  definition: ToolDefinition;
  /** True when the entry's own `approval` lists gate this tool. */
  gated: boolean;
}

export interface AssembledTools {
  toolDefs: ToolDefinition[];
  dispatch: Map<string, Dispatch>;
}

/** Per-invoke inputs shared by both agents (prompt xor messages, plus system/options
 *  overrides). */
export interface AgentInputs {
  prompt?: string;
  messages?: Message[];
  system?: SystemPrompt;
  options?: Record<string, unknown>;
  /** Caller data handed to every tool dispatch; the kernel fills `{}` when omitted. */
  context?: Record<string, unknown>;
  /** The caller's decisions on the calls the conversation left pending. */
  approvals?: ToolApproval[];
}

/** The manifest-level agent config the prelude reads (system prompt + base options). */
export interface AgentConfig {
  system?: SystemPrompt;
  options?: Record<string, unknown>;
}

/** Validate `prompt` xor `messages` and prepend the resolved system message (runtime
 *  input wins over manifest default). Shared by Ai.Agent and Ai.AgentStream so the
 *  input contract and its error messages live in one place. `label` is the agent's
 *  identity (e.g. `Ai.Agent "X"`). */
export function buildInitialMessages(
  inputs: AgentInputs,
  config: AgentConfig,
  label: string,
): Message[] {
  const hasPrompt = typeof inputs.prompt === "string";
  const hasMessages = Array.isArray(inputs.messages);
  if (hasPrompt === hasMessages) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      hasPrompt
        ? `${label}: exactly one of 'prompt' or 'messages' may be provided, not both.`
        : `${label}: one of 'prompt' or 'messages' is required.`,
    );
  }
  const base: Message[] = hasMessages
    ? inputs.messages!
    : [{ role: "user", content: inputs.prompt! }];
  const systemText = inputs.system ?? config.system;
  if (systemText === undefined) return [...base];
  return base[0]?.role === "system"
    ? [{ role: "system", content: systemText }, ...base.slice(1)]
    : [{ role: "system", content: systemText }, ...base];
}

/** Shallow-merge base (manifest) options under the per-call overrides; downstream wins. */
export function mergeAgentOptions(
  config: AgentConfig,
  inputs: AgentInputs,
): Record<string, unknown> {
  return { ...(config.options ?? {}), ...(inputs.options ?? {}) };
}

/** Give a model-requested call its one id, fixed where the call is first seen and
 *  carried by the assistant message that replays it and by its tool result. A model
 *  that supplies none gets a fresh one — unique across turns, runs and processes,
 *  since a transcript outlives the process that wrote it. Missing arguments default
 *  to `{}`. */
export function normalizeToolCall(call: ToolCall): ToolCall {
  return {
    id: call.id || `call_${randomUUID()}`,
    name: call.name,
    arguments: call.arguments ?? {},
  };
}

/** Refuse a call whose id an earlier call of the same model response carries:
 *  a result, a decision and a resume are each joined to their call by it. */
export function assertUniqueCallId(
  call: ToolCall,
  earlier: readonly ToolCall[],
  label: string,
): void {
  if (!earlier.some((other) => other.id === call.id)) return;
  throw new InvokeError(
    "ERR_CONTRACT_VIOLATION",
    `${label}: the model's response carried two tool calls with the id "${call.id}". Every tool call of one response has an id of its own, which is what joins a result, an approval and a resume to it.`,
  );
}

/** Normalize a tool's return value into message content. A string passes through;
 *  content parts (a single part or an array) are carried untouched so an image tool
 *  result reaches the model intact; anything else is written as plain JSON, a CEL
 *  value in its plain encoding. */
export function toToolContent(output: unknown): MessageContent {
  if (typeof output === "string") return output;
  if (isContentParts(output)) return output;
  if (isContentPart(output)) return [output];
  return writePlainJson(output);
}

/** The controller twin of the `AI_APPROVAL_NAME_FILTERED` resource rule,
 *  refused at creation as `ERR_AI_APPROVAL_NAME_FILTERED`: an `approval.include`
 *  name the entry's own `include` / `exclude` removes can gate nothing. */
export function checkApprovalNames(entries: ToolProviderEntry[] | undefined, label: string): void {
  for (const entry of entries ?? []) {
    for (const name of entry.approval?.include ?? []) {
      const removed =
        (entry.include !== undefined && !entry.include.includes(name)) ||
        (entry.exclude !== undefined && entry.exclude.includes(name));
      if (!removed) continue;
      throw new InvokeError(
        "ERR_AI_APPROVAL_NAME_FILTERED",
        `${label} lists "${name}" in a tool provider's 'approval.include', but the entry's own 'include' / 'exclude' removes that tool, so the name would gate nothing.`,
      );
    }
  }
}

/** Merge every tool provider into one advertised tool set + dispatch map: apply
 *  prefix/include/exclude, fan out `listTools()`, reject duplicate model-facing
 *  names, and mark the tools each entry's `approval` lists gate. `label` is the
 *  agent's identity for error messages (e.g. `Ai.Agent "X"`). */
export async function assembleTools(
  entries: ToolProviderEntry[] | undefined,
  label: string,
): Promise<AssembledTools> {
  const toolDefs: ToolDefinition[] = [];
  const dispatch = new Map<string, Dispatch>();

  for (const entry of entries ?? []) {
    const provider = entry.provider;
    if (
      !provider ||
      typeof provider.listTools !== "function" ||
      typeof provider.callTool !== "function"
    ) {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `${label}: a toolProviders entry did not resolve to a live Ai.ToolProvider instance.`,
      );
    }
    const exposed = (await provider.listTools()).filter(
      (d) =>
        (!entry.include || entry.include.includes(d.name)) &&
        !(entry.exclude && entry.exclude.includes(d.name)),
    );
    const approval = entry.approval;
    const unknown = approval?.include?.find((name) => !exposed.some((d) => d.name === name));
    if (unknown !== undefined) {
      throw new InvokeError(
        "ERR_AGENT_APPROVAL_UNKNOWN_TOOL",
        `${label}: 'approval.include' names "${unknown}", which the tool provider entry does not expose. It exposes: ${exposed.map((d) => d.name).join(", ") || "no tools"}.`,
      );
    }
    for (const d of exposed) {
      // Absent gates none; `include` gates exactly its names; otherwise every
      // exposed tool is gated; `exclude` takes names out of the gated set.
      const gated =
        approval !== undefined &&
        (approval.include === undefined || approval.include.includes(d.name)) &&
        !(approval.exclude ?? []).includes(d.name);
      const modelName = (entry.prefix ?? "") + d.name;
      if (dispatch.has(modelName)) {
        throw new InvokeError(
          "ERR_AGENT_TOOL_COLLISION",
          `${label}: duplicate tool name "${modelName}" across providers — set a 'prefix' to disambiguate.`,
        );
      }
      const definition = { name: modelName, description: d.description, parameters: d.parameters };
      dispatch.set(modelName, { provider, bareName: d.name, definition, gated });
      toolDefs.push(definition);
    }
  }

  return { toolDefs, dispatch };
}

/** The record of a call that failed and whose failure is fed back to the model. */
export function toolFailureRecord(
  call: ToolCall,
  err: unknown,
  maxToolResultBytes: number | undefined,
): ToolResultRecord {
  const message = err instanceof Error ? err.message : String(err);
  return {
    toolCallId: call.id,
    name: call.name,
    content: boundToolContent(`Error: ${message}`, maxToolResultBytes),
    error: true,
  };
}

/** The record of a call that was decided against and never ran. What the model
 *  is told depends on the reason alone, whoever gave it. */
export function deniedToolRecord(
  call: ToolCall,
  reason: string | undefined,
  maxToolResultBytes: number | undefined,
): ToolResultRecord {
  const text =
    `Denied: the call to "${call.name}" was not approved and did not run.` +
    (reason ? ` Reason: ${reason}` : "");
  return {
    toolCallId: call.id,
    name: call.name,
    content: boundToolContent(text, maxToolResultBytes),
    denied: true,
  };
}

/** Execute one model-requested tool call and return a neutral result record. On
 *  `onToolError: "feedback"` a failure (unknown tool or a throw from the tool)
 *  becomes an `error: true` record whose `content` is the error string fed back to
 *  the model; on `"throw"` the error propagates and aborts the invoke. The turn's
 *  cancellation and a durable suspension are not tool failures: they propagate
 *  whatever `onToolError` says.
 *
 *  The call runs under an `execute_tool <name>` span opened on `ctx` — the agent
 *  run's span context — and that span's context is what the provider receives, so
 *  cancelling the turn reaches the running tool and the tool's own dispatch nests
 *  under the span. `context` is the agent's caller data, handed to the provider
 *  for its tools to read. `output` is the tool's result before any mapping the provider
 *  applies, as plain JSON; it is never fed to the model. `content`, the error string
 *  included, is bounded by `maxToolResultBytes` (undefined: unbounded); `output`
 *  never is. */
export async function dispatchToolCall(
  call: ToolCall,
  dispatch: Map<string, Dispatch>,
  onToolError: "feedback" | "throw",
  maxToolResultBytes: number | undefined,
  label: string,
  spans: SpanOpener,
  agent: AgentSpanIdentity,
  ctx: InvokeContext | undefined,
  context: Record<string, unknown>,
): Promise<ToolResultRecord> {
  const span = await openToolSpan(spans, ctx, agent, { name: call.name, callId: call.id });
  const target = dispatch.get(call.name);
  if (!target) {
    const error = new InvokeError(
      "ERR_AGENT_UNKNOWN_TOOL",
      `${label}: model requested unknown tool "${call.name}".`,
    );
    await settleFailure(span, error);
    if (onToolError === "throw") throw error;
    return {
      toolCallId: call.id,
      name: call.name,
      content: boundToolContent(`Error: no such tool "${call.name}".`, maxToolResultBytes),
      error: true,
    };
  }
  let called: { output: unknown; result: unknown };
  try {
    called = target.provider.callToolWithOutput
      ? await target.provider.callToolWithOutput(
          target.bareName,
          call.arguments,
          span.context,
          context,
        )
      : await target.provider
          .callTool(target.bareName, call.arguments, span.context, context)
          .then((output) => ({ output, result: output }));
  } catch (err) {
    await settleFailure(span, err);
    if (onToolError === "throw" || isCancellationError(err) || isSuspension(err)) throw err;
    return toolFailureRecord(call, err, maxToolResultBytes);
  }
  await span.settle("ok");
  return {
    toolCallId: call.id,
    name: call.name,
    content: boundToolContent(toToolContent(called.result), maxToolResultBytes),
    // Present on every successful call: a tool that returns nothing produced
    // `null`, which is a value a consumer can read, unlike a missing key.
    output: called.output === undefined ? null : toPlainJson(called.output),
  };
}
