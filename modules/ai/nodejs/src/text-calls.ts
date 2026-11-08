import type { ResourceContext } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { AssembledTools } from "./agent-tools.js";
import { contentToText, type MessageContent, type TextPart } from "./content.js";
import { attributeMap, blockLabel, extractBlocks, type OpenBlock, type TextBlock } from "./text-blocks.js";
import { textCallId } from "./text-call-id.js";
import type { Message, ToolCall } from "./types.js";

/**
 * An agent's `textTools`: the fenced blocks of a model reply gathered, per
 * entry, into one call of a tool a provider advertises. Shared by `Ai.Agent`
 * and `Ai.AgentStream`, so the two derive the same calls, ids and results from
 * the same reply.
 */

/** One `textTools` entry, as the manifest declares it. */
export interface TextToolEntry {
  tags: string[];
  /** The advertised tool name, the provider entry's `prefix` included. */
  tool: string;
  /** Mapping from `blocks` to the tool's arguments; its values are CEL. */
  arguments: Record<string, unknown>;
}

/** What a text call is. */
export type TextCall = {
  id: string;
  tool: string;
  /** The entry's tags. */
  tags: string[];
  /** The blocks it carries — for a withheld reply, the block left open. */
  blocks: OpenBlock[];
  /** The call as a tool call: the evaluated arguments, `{}` when they failed. */
  toolCall: ToolCall;
} & (
  | { form: "call" }
  /** `arguments` failed to evaluate: the call fails and is not dispatched. */
  | { form: "unevaluated"; failure: unknown }
  /** The reply ended inside a listed block: its blocks are withheld. */
  | { form: "withheld" }
);

/** A text result part: what the model is told about one text call. */
export type TextResultPart = TextPart & { kind: typeof TEXT_TOOL_RESULT; toolCallId: string };

export const TEXT_TOOL_RESULT = "text-tool-result" as const;

/** Whether a part is a text call's result. */
export function isTextResultPart(part: unknown): part is TextResultPart {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    (part as { kind?: unknown }).kind === TEXT_TOOL_RESULT &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

/** Whether a message is made only of text call results. */
export function isTextResultMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(isTextResultPart)
  );
}

/** The text-call result parts a message holds, by call id. */
export function textResultIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (isTextResultPart(part)) ids.add(part.toolCallId);
  }
  return ids;
}

/** The tag every entry lists, once, refused at creation when listed twice
 *  across entries — the controller twin of `AI_TEXT_TOOL_TAG_DUPLICATE`. */
export function checkTextToolTags(entries: readonly TextToolEntry[] | undefined, label: string): void {
  const owner = new Map<string, number>();
  (entries ?? []).forEach((entry, index) => {
    for (const tag of entry.tags) {
      const earlier = owner.get(tag);
      if (earlier !== undefined && earlier !== index) {
        throw new InvokeError(
          "ERR_AI_TEXT_TOOL_TAG_DUPLICATE",
          `${label}: textTools[${index}] lists the tag "${tag}", which textTools[${earlier}] lists too. A block is gathered by exactly one entry, so each tag belongs to one.`,
        );
      }
      owner.set(tag, index);
    }
  });
}

/** Argument keys the tool's schema would refuse at its top level: absent from
 *  `properties`, matched by no `patternProperties`, under `additionalProperties: false`. */
function refusedKeys(keys: readonly string[], parameters: Record<string, unknown>): string[] {
  if (parameters.additionalProperties !== false) return [];
  const properties = (parameters.properties ?? {}) as Record<string, unknown>;
  const patterns = Object.keys((parameters.patternProperties ?? {}) as Record<string, unknown>).map(
    (pattern) => new RegExp(pattern, "u"),
  );
  return keys.filter(
    (key) => !Object.hasOwn(properties, key) && !patterns.some((pattern) => pattern.test(key)),
  );
}

/** Each entry held to the tool set the agent assembled — the controller twins
 *  of `AI_TEXT_TOOL_UNKNOWN`, `AI_TEXT_TOOL_ARGUMENT_UNKNOWN` and
 *  `AI_TEXT_TOOL_ARGUMENT_MISSING`, over every provider's advertised schemas. */
export function checkTextTools(
  entries: readonly TextToolEntry[] | undefined,
  tools: AssembledTools,
  label: string,
): void {
  (entries ?? []).forEach((entry, index) => {
    const target = tools.dispatch.get(entry.tool);
    if (!target) {
      throw new InvokeError(
        "ERR_AI_TEXT_TOOL_UNKNOWN",
        `${label}: textTools[${index}] names the tool "${entry.tool}", which no tool provider advertises. Advertised: ${[...tools.dispatch.keys()].join(", ") || "no tools"}.`,
      );
    }
    const parameters = target.definition.parameters ?? {};
    const keys = Object.keys(entry.arguments ?? {});
    const unknown = refusedKeys(keys, parameters);
    if (unknown.length > 0) {
      throw new InvokeError(
        "ERR_AI_TEXT_TOOL_ARGUMENT_UNKNOWN",
        `${label}: textTools[${index}] maps the argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}, which the parameters of "${entry.tool}" do not allow.`,
      );
    }
    const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
    const missing = required.filter((name) => !keys.includes(name));
    if (missing.length > 0) {
      throw new InvokeError(
        "ERR_AI_TEXT_TOOL_ARGUMENT_MISSING",
        `${label}: textTools[${index}] leaves the required parameter${missing.length > 1 ? "s" : ""} ${missing.map((k) => `"${k}"`).join(", ")} of "${entry.tool}" unmapped.`,
      );
    }
  });
}

/** What `blocks` binds a block as. */
function boundBlock(block: TextBlock): { tag: string; attributes: Record<string, string>; body: string } {
  return { tag: block.tag, attributes: attributeMap(block), body: block.body };
}

/**
 * The text calls a reply yields, in order: one per entry whose tags it holds,
 * ordered by each entry's first block — or, when the reply ends inside a
 * listed block, the one withheld call naming it. `text` is the assistant
 * message's recorded text, which the ids are derived from.
 */
export function textCallsOf(
  text: string,
  entries: readonly TextToolEntry[] | undefined,
  ctx: ResourceContext,
): TextCall[] {
  if (!entries || entries.length === 0) return [];
  const listed = new Set(entries.flatMap((entry) => entry.tags));
  const { blocks, open, malformed } = extractBlocks(text, listed);
  const entryOf = (tag: string) => entries.find((entry) => entry.tags.includes(tag))!;

  if (malformed) {
    const entry = entryOf(malformed.tag);
    const id = textCallId({ text, tool: entry.tool, tags: entry.tags, arguments: null });
    const token = malformed.token.replace(/\t/g, "\\t");
    return [
      {
        id,
        tool: entry.tool,
        tags: entry.tags,
        blocks: [{ tag: malformed.tag, attributes: [] }],
        toolCall: { id, name: entry.tool, arguments: {} },
        form: "unevaluated",
        failure: new Error(
          `attribute \`${token}\` of the ${malformed.tag} block must be name=value, separated by single spaces, with no quotes or spaces in either part; no block of this reply was run.`,
        ),
      },
    ];
  }

  if (open) {
    const entry = entryOf(open.tag);
    const id = textCallId({ text, tool: entry.tool, tags: entry.tags, arguments: null });
    return [
      {
        id,
        tool: entry.tool,
        tags: entry.tags,
        blocks: [open],
        toolCall: { id, name: entry.tool, arguments: {} },
        form: "withheld",
      },
    ];
  }

  const groups = new Map<TextToolEntry, TextBlock[]>();
  for (const block of blocks) {
    const entry = entryOf(block.tag);
    const group = groups.get(entry);
    if (group) group.push(block);
    else groups.set(entry, [block]);
  }

  return [...groups].map(([entry, carried]): TextCall => {
    const base = {
      tool: entry.tool,
      tags: entry.tags,
      blocks: carried.map(({ tag, attributes }) => ({ tag, attributes })),
    };
    let evaluated: Record<string, unknown>;
    try {
      evaluated = ctx.expandValue(entry.arguments, { blocks: carried.map(boundBlock) }) as Record<
        string,
        unknown
      >;
    } catch (failure) {
      const id = textCallId({ text, tool: entry.tool, tags: entry.tags, arguments: null });
      return { ...base, id, toolCall: { id, name: entry.tool, arguments: {} }, form: "unevaluated", failure };
    }
    const id = textCallId({ text, tool: entry.tool, tags: entry.tags, arguments: evaluated });
    return { ...base, id, toolCall: { id, name: entry.tool, arguments: evaluated }, form: "call" };
  });
}

/** The line every text call result opens with: its tool and the blocks it carried. */
export function textCallHeader(call: TextCall): string {
  return `${call.tool} (${call.blocks.map(blockLabel).join(", ")}):`;
}

/** What the model is told about a reply whose blocks were withheld. */
export function withheldNotice(call: TextCall): string {
  return `the reply ended inside ${blockLabel(call.blocks[0]!)} before its closing fence; no block of this reply was run. Send the change again in smaller blocks.`;
}

/** What the model is told about a text call an earlier failure stopped. */
export const NOT_RUN = "not run: an earlier text call of this reply failed.";

/** A text call's result as the text the model is told: its header, then the
 *  tool's own rendering — text only, since a text part carries no media. */
export function textCallResult(call: TextCall, content: MessageContent): string {
  return `${textCallHeader(call)}\n${contentToText(content)}`;
}

/** The part recording one text call's result. */
export function textResultPart(call: TextCall, text: string): TextResultPart {
  return { type: "text", text, kind: TEXT_TOOL_RESULT, toolCallId: call.id };
}

/** What `steps[i].textCalls` records of a call. */
export interface TextCallTrace {
  id: string;
  tool: string;
  blocks: Array<{ tag: string; attributes: Record<string, string> }>;
  ok: boolean;
}

export function textCallTrace(call: TextCall): TextCallTrace {
  return {
    id: call.id,
    tool: call.tool,
    blocks: call.blocks.map((block) => ({ tag: block.tag, attributes: attributeMap(block) })),
    ok: false,
  };
}
