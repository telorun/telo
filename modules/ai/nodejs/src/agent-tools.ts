import { InvokeError } from "@telorun/sdk";
import { isContentPart, isContentParts, type MessageContent } from "./content.js";
import type {
  AiToolProviderInstance,
  Message,
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
 * output — the buffered agent pushes it onto its `StepTrace`, the streaming agent
 * emits it as a `tool-result` event.
 */
export interface ToolProviderEntry {
  /** Live Ai.ToolProvider instance after Phase 5 injection. */
  provider: AiToolProviderInstance;
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

export interface Dispatch {
  provider: AiToolProviderInstance;
  bareName: string;
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
  system?: string;
  options?: Record<string, unknown>;
}

/** The manifest-level agent config the prelude reads (system prompt + base options). */
export interface AgentConfig {
  system?: string;
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

/** Give every model-requested call a stable id (threaded into the tool-result message
 *  so the model can correlate result→call) and default missing arguments to `{}`. */
export function normalizeToolCalls(calls: ToolCall[], step: number): ToolCall[] {
  return calls.map((c, i) => ({
    id: c.id || `call_${step}_${i}`,
    name: c.name,
    arguments: c.arguments ?? {},
  }));
}

/** Normalize a tool's return value into message content. A string passes through;
 *  content parts (a single part or an array) are carried untouched so an image tool
 *  result reaches the model intact; anything else is JSON-stringified, the historical
 *  default for structured tool output. */
export function toToolContent(output: unknown): MessageContent {
  if (typeof output === "string") return output;
  if (isContentParts(output)) return output;
  if (isContentPart(output)) return [output];
  return JSON.stringify(output);
}

/** Merge every tool provider into one advertised tool set + dispatch map: apply
 *  prefix/include/exclude, fan out `listTools()`, and reject duplicate model-facing
 *  names. `label` is the agent's identity for error messages (e.g. `Ai.Agent "X"`). */
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
    const descriptors = await provider.listTools();
    for (const d of descriptors) {
      if (entry.include && !entry.include.includes(d.name)) continue;
      if (entry.exclude && entry.exclude.includes(d.name)) continue;
      const modelName = (entry.prefix ?? "") + d.name;
      if (dispatch.has(modelName)) {
        throw new InvokeError(
          "ERR_AGENT_TOOL_COLLISION",
          `${label}: duplicate tool name "${modelName}" across providers — set a 'prefix' to disambiguate.`,
        );
      }
      dispatch.set(modelName, { provider, bareName: d.name });
      toolDefs.push({ name: modelName, description: d.description, parameters: d.parameters });
    }
  }

  return { toolDefs, dispatch };
}

/** Execute one model-requested tool call and return a neutral result record. On
 *  `onToolError: "feedback"` a failure (unknown tool or a throw from the tool)
 *  becomes an `error: true` record whose `content` is the error string fed back to
 *  the model; on `"throw"` the error propagates and aborts the invoke. */
export async function dispatchToolCall(
  call: ToolCall,
  dispatch: Map<string, Dispatch>,
  onToolError: "feedback" | "throw",
  label: string,
): Promise<ToolResultRecord> {
  const target = dispatch.get(call.name);
  if (!target) {
    if (onToolError === "throw") {
      throw new InvokeError(
        "ERR_AGENT_UNKNOWN_TOOL",
        `${label}: model requested unknown tool "${call.name}".`,
      );
    }
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Error: no such tool "${call.name}".`,
      error: true,
    };
  }
  try {
    const output = await target.provider.callTool(target.bareName, call.arguments);
    return { toolCallId: call.id, name: call.name, content: toToolContent(output) };
  } catch (err) {
    if (onToolError === "throw") throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { toolCallId: call.id, name: call.name, content: `Error: ${message}`, error: true };
  }
}
