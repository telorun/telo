import { randomUUID } from "node:crypto";
import {
  contentToText,
  isMediaPart,
  isTextPart,
  type ContentPart,
  type MessageContent,
} from "@telorun/ai";
import type {
  AiModelInstance,
  AiModelStreamInstance,
  CompletionResult,
  FinishReason,
  Message,
  ModelInvokeInput,
  ModelStreamResult,
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
import { mergeOptions, toOpenAiParams, toResponsesTextFormat } from "./openai-params.js";
import { callOpenAi, type HttpRequestInstance } from "./openai-endpoint.js";
import { parseSseData } from "./openai-sse.js";
import {
  contentUnsupported,
  dataUrl,
  namedFileData,
  OUTPUT_ONLY,
  parseToolArguments,
  remoteUrl,
} from "./openai-message-parts.js";

/**
 * OpenAI's `/v1/responses` surface, for the Ai.Model and Ai.ModelStream
 * abstracts.
 *
 * A SEPARATE KIND from the chat-completions provider rather than a dialect flag
 * on it. The two share a vendor and almost nothing else: `input` items against
 * `messages`, `instructions` against a system role, flat tools against nested
 * ones, an `output` array against `choices`, named `response.*` events against
 * `[DONE]`-terminated chunks, and a `providerState` that means an opaque
 * reasoning item here and nothing at all there. Under one kind every one of
 * those fields would read differently depending on a sibling scalar — and
 * reasoning, which `/chat/completions` refuses outright alongside function
 * tools, would be a field that is sometimes a hard 400.
 *
 * That refusal is why this exists: a reasoning model called with tools has to
 * come through here.
 */

interface ResponsesResource {
  metadata: { name: string; module?: string };
  model: string;
  /** Injected by Phase 5 — the account's base URL and credential live on its
   *  client, so this module holds no key. */
  request: HttpRequestInstance;
  reasoning?: { effort?: string; summary?: string };
  options?: Record<string, unknown>;
}

// --- Responses wire shapes (only the fields this controller reads) ---

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

interface ResponsesMessageContent {
  type: string;
  text?: string;
  refusal?: string;
}

interface ResponsesItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: ResponsesMessageContent[];
  summary?: Array<{ type?: string; text?: string }>;
  /** LOAD-BEARING, and the one place this file's "only the fields it reads are
   *  declared" rule is deliberately relaxed: a reasoning item is replayed
   *  VERBATIM, so `encrypted_content` and anything else the endpoint puts on it
   *  has to survive a round trip. The cost is that excess-property checking is
   *  off for every `ResponsesItem` literal here. */
  [key: string]: unknown;
}

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: ResponsesItem[];
  usage?: ResponsesUsage;
}

/** One streamed frame. The vocabulary is named events rather than positional
 *  deltas, so only the members this controller acts on are declared. */
interface ResponsesEvent {
  type: string;
  delta?: string;
  /** On an argument delta: the function-call ITEM it belongs to — the item's own
   *  id, not the call id a tool result answers. */
  item_id?: string;
  /** The position of the item an event concerns in the answer's output. */
  output_index?: number;
  item?: ResponsesItem;
  response?: ResponsesBody;
  message?: string;
  error?: { message?: string };
}

/**
 * What a turn's reasoning is carried as between requests.
 *
 * TAGGED, and the tag is checked before replay: an item minted by one model on
 * one dialect is meaningless to another, and a transcript legitimately moves
 * between them (an app declaring both kinds, a model variable changed between
 * deployments). Replaying a foreign item is a 400 at best; dropping it silently
 * costs one turn's reasoning, which is what the chain is allowed to lose.
 */
interface ResponsesProviderState {
  api: "responses";
  model: string;
  /** The declaring resource, MODULE-QUALIFIED. A model id alone is not identity:
   *  two resources can name the same model over DIFFERENT accounts — a direct
   *  endpoint and a gateway — and an opaque item minted by one is refused by the
   *  other, which is exactly the 400 the tag exists to prevent. Qualified because
   *  a resource name is module-scoped, so two libraries each declaring a model
   *  would otherwise mint the same tag. */
  resource: string;
  items: ResponsesItem[];
}

/** `<module>.<name>`, so the tag is unique across the whole application rather
 *  than within one module's scope. */
function qualifiedName(resource: { metadata: { name: string; module?: string } }): string {
  const { module, name } = resource.metadata;
  return module ? `${module}.${name}` : name;
}

function isOwnState(
  state: unknown,
  model: string,
  resource: string,
): state is ResponsesProviderState {
  const s = state as ResponsesProviderState | undefined;
  return (
    !!s &&
    s.api === "responses" &&
    s.model === model &&
    s.resource === resource &&
    Array.isArray(s.items) &&
    s.items.length > 0
  );
}

/** The two breakdowns are carried only when the endpoint reports them: absent
 *  means "not said", which is not zero. */
function mapUsage(u: ResponsesUsage | undefined): Usage {
  const cached = u?.input_tokens_details?.cached_tokens;
  const reasoning = u?.output_tokens_details?.reasoning_tokens;
  return {
    promptTokens: u?.input_tokens ?? 0,
    completionTokens: u?.output_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
    ...(typeof cached === "number" ? { cachedPromptTokens: cached } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Why the turn ended.
 *
 * `/v1/responses` reports no `finish_reason`: it reports a run STATUS plus, when
 * that status is `incomplete`, a reason for the truncation. Tool calls are
 * therefore derived from the output itself — a turn that asked for tools ended
 * because it asked for tools.
 */
function mapFinishReason(body: ResponsesBody | undefined, askedForTools: boolean): FinishReason {
  if (askedForTools) return "tool-calls";
  const reason = body?.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content-filter";
  if (body?.status === "completed") return "stop";
  // `failed` is deliberately absent: `Ai.FinishReason` has no `error` member,
  // because a failure REJECTS rather than being reported as a reason for the
  // answer. A failed run is raised by the caller of this function.
  return body?.status === undefined ? "stop" : "other";
}

// --- Request translation ---

type InputItem = Record<string, unknown>;

const TAKES_REFERENCE = "This endpoint takes an image or a file as bytes or by an http(s) URL.";
const TAKES_MEDIA = "This endpoint takes text, images and files.";

/**
 * One content part as a responses `input_*` part, or the refusal of one this
 * dialect cannot carry: an image or a file goes by bytes or by URL, and audio,
 * video and every part a model produces not at all. Refused rather than
 * dropped — dropping it would send a request quietly missing part of the
 * message.
 */
function translatePart(part: ContentPart, label: string): InputItem {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image":
      return {
        type: "input_image",
        image_url: part.uri === undefined ? dataUrl(part) : remoteUrl(part, label, TAKES_REFERENCE),
      };
    case "file":
      return part.uri === undefined
        ? { type: "input_file", ...namedFileData(part, label) }
        : { type: "input_file", file_url: remoteUrl(part, label, TAKES_REFERENCE) };
    case "audio":
    case "video":
      throw contentUnsupported(label, part, TAKES_MEDIA);
    default:
      throw contentUnsupported(label, part, OUTPUT_ONLY);
  }
}

/** Translate a caller's message content into responses `input_*` parts. */
function translateContent(content: MessageContent, label: string): InputItem[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part) => translatePart(part, label));
}

/**
 * What a tool returned, as its `function_call_output`'s `output`. Text alone is
 * a string. Media rides the output itself: the tool's text and media parts in
 * the order it returned them, each translated as a user message's would be —
 * so a media part a user message is refused, a tool result is refused the same
 * way. A part a model produces is left out, not refused.
 */
function toolOutput(content: MessageContent, label: string): string | InputItem[] {
  if (typeof content === "string" || !content.some(isMediaPart)) return contentToText(content);
  return content
    .filter((part) => isTextPart(part) || isMediaPart(part))
    .map((part) => translatePart(part, label));
}

interface TranslatedInput {
  input: InputItem[];
  instructions?: string;
}

/**
 * Messages → `input` items, with the system turns hoisted to `instructions`.
 *
 * `providerState` is spliced in at the position it was produced: immediately
 * before the function calls of the most recent assistant turn. The endpoint
 * requires a reasoning item to precede the call it reasoned about, and the
 * contract hands the state over out-of-band, so the position has to be
 * reconstructed here — appending it would be accepted and answered wrongly.
 */
function translateMessages(
  messages: Message[],
  providerState: unknown,
  model: string,
  label: string,
  resourceId: string,
): TranslatedInput {
  const input: InputItem[] = [];
  const instructions: string[] = [];
  // Where the newest assistant turn's function calls begin — the slot the
  // reasoning items belong in.
  let toolCallStart = -1;

  for (const m of messages) {
    if (m.role === "system") {
      instructions.push(contentToText(m.content));
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: toolOutput(m.content, label),
      });
      continue;
    }
    if (m.role === "assistant") {
      const text = contentToText(m.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      if (m.toolCalls && m.toolCalls.length > 0) {
        toolCallStart = input.length;
        for (const call of m.toolCalls) {
          input.push({
            type: "function_call",
            // The contract's ToolCall.id IS the endpoint's `call_id` — the value a
            // `function_call_output` keys on. The item's own `id` is a different
            // value and correlates nothing a caller can see.
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          });
        }
      }
      continue;
    }
    input.push({ role: m.role, content: translateContent(m.content, label) });
  }

  if (isOwnState(providerState, model, resourceId)) {
    const at = toolCallStart === -1 ? input.length : toolCallStart;
    input.splice(at, 0, ...(providerState.items as unknown as InputItem[]));
  }

  return {
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
  };
}

/** Tools are FLAT here — `{type, name, description, parameters}` — where the chat
 *  dialect nests them under `function`. */
function buildTools(defs: ToolDefinition[] | undefined): unknown[] | undefined {
  if (!defs || defs.length === 0) return undefined;
  return defs.map((d) => ({
    type: "function",
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    parameters: d.parameters,
  }));
}

function toolCallOf(item: ResponsesItem): ToolCall {
  return {
    id: item.call_id ?? item.id ?? "",
    name: item.name ?? "",
    arguments: parseToolArguments(item.arguments, item.name ?? "(unnamed)"),
  };
}

/** The text a reasoning item exposes. Empty unless a `summary` was asked for —
 *  the reasoning itself is encrypted and only ever replayed. */
function reasoningText(item: ResponsesItem): string {
  return (item.summary ?? [])
    .map((s) => s.text ?? "")
    .filter((t) => t !== "")
    .join("\n");
}

/** What the two kinds share: the endpoint, the request translation, the reading
 *  of a completed item, and the snapshot. */
abstract class ResponsesBase {
  constructor(protected readonly resource: ResponsesResource) {}

  /** No redaction needed: the key is the client's, and a credential's own
   *  output is marked `x-telo-sensitive`. */
  snapshot(): Record<string, unknown> {
    return {
      model: this.resource.model,
      ...(this.resource.reasoning ? { reasoning: this.resource.reasoning } : {}),
      ...(this.resource.options ? { options: this.resource.options } : {}),
    };
  }

  /** `text` is a real responses-API object carrying `verbosity` beside `format`,
   *  and the options bag can set it. Merged rather than replaced: overwriting it
   *  would drop a sibling the author declared, with no error. */
  private textBlock(
    params: Record<string, unknown>,
    responseFormat: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const existing = (params.text ?? undefined) as Record<string, unknown> | undefined;
    if (!responseFormat) return existing;
    return { ...(existing ?? {}), format: toResponsesTextFormat(responseFormat) };
  }

  protected buildBody(input: ModelInvokeInput, stream: boolean): Record<string, unknown> {
    const translated = translateMessages(
      input.messages,
      input.providerState,
      this.resource.model,
      `OpenAI responses "${this.resource.metadata.name}"`,
      qualifiedName(this.resource),
    );
    const tools = buildTools(input.tools);
    const params = toOpenAiParams(mergeOptions(this.resource.options, input.options));
    const text = this.textBlock(params, input.responseFormat);
    return {
      model: this.resource.model,
      ...translated,
      ...(tools ? { tools } : {}),
      ...(this.resource.reasoning ? { reasoning: this.resource.reasoning } : {}),
      ...params,
      // After the options, so the call's own choice is what is sent.
      ...(tools && input.toolChoice ? { tool_choice: input.toolChoice } : {}),
      ...(text ? { text } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  /** Wrap the reasoning items of one turn for replay on the next. */
  protected stateOf(items: ResponsesItem[]): ResponsesProviderState | undefined {
    if (items.length === 0) return undefined;
    return {
      api: "responses",
      model: this.resource.model,
      resource: qualifiedName(this.resource),
      items,
    };
  }
}

class ResponsesModelInstance extends ResponsesBase implements ResourceInstance, AiModelInstance {
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult> {
    const data = (await callOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      "OpenAI responses",
      { path: "/responses", body: this.buildBody(input, false) },
      ctx,
    )) as ResponsesBody;

    // A run the endpoint answered 200 for and then reported as FAILED. It has to
    // raise, not report a reason: `Ai.FinishReason` has no `error` member, so
    // returning one is an `ERR_OUTPUT_INVALID` at dispatch — and it would bury
    // the endpoint's own explanation under a message about an enum. Same code
    // and same shape as the streaming half.
    if (data.status === "failed") {
      throw new InvokeError(
        "ERR_OPENAI_REQUEST_FAILED",
        `OpenAI responses "${this.resource.metadata.name}": the run failed. ` +
          `${data.error?.message ?? "The endpoint gave no reason."}`,
      );
    }

    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    const reasoningItems: ResponsesItem[] = [];
    let text = "";

    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) {
            content.push({ type: "text", text: part.text });
            text += part.text;
          } else if (part.type === "refusal" && part.refusal) {
            content.push({ type: "refusal", text: part.refusal });
          }
        }
      } else if (item.type === "function_call") {
        toolCalls.push(toolCallOf(item));
      } else if (item.type === "reasoning") {
        reasoningItems.push(item);
        const summary = reasoningText(item);
        if (summary) content.push({ type: "reasoning", text: summary });
      }
    }

    const state = this.stateOf(reasoningItems);
    return {
      content,
      text,
      usage: mapUsage(data.usage),
      finishReason: mapFinishReason(data, toolCalls.length > 0),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(state ? { providerState: state } : {}),
    };
  }
}

class ResponsesModelStreamInstance
  extends ResponsesBase
  implements ResourceInstance, AiModelStreamInstance
{
  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<ModelStreamResult> {
    // Built here rather than when the stream is first read: a part this dialect
    // cannot carry fails the CALL, and only the endpoint's own failures reject
    // the iteration.
    return { output: new Stream(this.parts(this.buildBody(input, true), ctx)) };
  }

  private async *parts(
    requestBody: Record<string, unknown>,
    ctx?: InvokeContext,
  ): AsyncIterable<StreamPart> {
    // A refused request FAILS — the status check lives in `callOpenAi`, which
    // reads the provider's own message out of the body. Parts already emitted
    // still reach the consumer when a failure comes later.
    const body = await callOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      "OpenAI responses stream",
      { path: "/responses", body: requestBody, stream: true },
      ctx,
    );

    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let completed: ResponsesBody | undefined;
    let sawTerminal = false;
    let sawToolCall = false;
    const reasoningItems: ResponsesItem[] = [];
    // Function calls being written, by ITEM. An argument delta names only its
    // item, so the call id and the tool name it is reported under are learned
    // from the item's `added` event; until both are known its text is held.
    const streaming = new Map<string, StreamedCall>();

    for await (const data of parseSseData(
      body as AsyncIterable<Uint8Array>,
      `OpenAI responses stream "${this.resource.metadata.name}"`,
    )) {
      // The responses stream ends after `response.completed` rather than with a
      // sentinel; the chat dialect's `[DONE]` is tolerated so a gateway that
      // appends one is not read as a frame.
      if (data === "[DONE]") break;
      const event = JSON.parse(data) as ResponsesEvent;
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text-delta", delta: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          if (event.delta) yield { type: "reasoning-delta", delta: event.delta };
          break;
        case "response.output_item.added": {
          const item = event.item;
          const key = itemKey(event);
          if (item?.type === "function_call" && key !== undefined) {
            streaming.set(key, { id: item.call_id ?? "", name: item.name ?? "", held: "" });
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const key = itemKey(event);
          if (!event.delta || key === undefined) break;
          const call = streaming.get(key) ?? { id: "", name: "", held: "" };
          streaming.set(key, call);
          call.held += event.delta;
          if (call.id && call.name) yield* releaseHeld(call);
          break;
        }
        case "response.output_item.done": {
          const item = event.item;
          if (!item) break;
          if (item.type === "function_call") {
            sawToolCall = true;
            const toolCall = toolCallOf(item);
            const key = itemKey(event);
            const call = (key === undefined ? undefined : streaming.get(key)) ?? {
              id: "",
              name: "",
              held: "",
            };
            // The id its deltas already went out under is the call's id. One the
            // endpoint never gave is minted here — unique across the model calls
            // of a run — and whatever is still held goes out under it first.
            toolCall.id = call.id || toolCall.id || `call_${randomUUID()}`;
            call.id = toolCall.id;
            call.name ||= toolCall.name;
            yield* releaseHeld(call);
            if (key !== undefined) streaming.delete(key);
            yield { type: "tool-call", toolCall };
          } else if (item.type === "reasoning") {
            reasoningItems.push(item);
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
          completed = event.response;
          sawTerminal = true;
          usage = mapUsage(event.response?.usage);
          break;
        case "error":
        case "response.failed":
          // A stream FAILS BY REJECTING. An error part would have to be
          // remembered by every drainer, and one that forgets truncates
          // silently; a thrown error also reaches `catches:` and a throws union.
          throw new InvokeError(
            "ERR_OPENAI_REQUEST_FAILED",
            `OpenAI responses stream "${this.resource.metadata.name}": the endpoint failed ` +
              `mid-stream. ${streamFailureMessage(event)}`,
          );
        default:
          // The vocabulary is open and grows: lifecycle frames
          // (`response.created`, `.in_progress`, `.content_part.*`, the `.done`
          // twin of every delta) carry nothing
          // this contract reports, and an unknown frame is not an error.
          break;
      }
    }

    // The bytes ran out with no terminal event — a cut connection, a proxy that
    // closed, a truncated body. Reporting `finish` here would render an
    // interrupted answer as a clean stop with zero usage, which is the one thing
    // a consumer cannot detect for itself.
    if (!sawTerminal) {
      throw new InvokeError(
        "ERR_OPENAI_REQUEST_FAILED",
        `OpenAI responses stream "${this.resource.metadata.name}": the stream ended without ` +
          `a terminal event, so the answer is incomplete.`,
      );
    }

    const state = this.stateOf(reasoningItems);
    if (state) yield { type: "provider-state", providerState: state };
    yield { type: "finish", usage, finishReason: mapFinishReason(completed, sawToolCall) };
  }
}

/** One streamed function call being written. */
interface StreamedCall {
  /** The call id its deltas are reported under; empty until the endpoint names it. */
  id: string;
  name: string;
  /** Argument text not yet reported as a delta. */
  held: string;
}

/** Which output item an event concerns: its id, or — from an endpoint that
 *  gives items none — its position in the output. */
function itemKey(event: ResponsesEvent): string | undefined {
  const id = event.item_id ?? event.item?.id;
  if (id) return id;
  return event.output_index === undefined ? undefined : `#${event.output_index}`;
}

/** Report the argument text a call is holding, under the id it now has. */
function* releaseHeld(call: StreamedCall): Generator<StreamPart> {
  if (call.held === "") return;
  const delta = call.held;
  call.held = "";
  yield { type: "tool-call-delta", toolCallId: call.id, toolName: call.name, delta };
}

/** The provider's own words for a mid-stream failure. A bare `error` frame carries
 *  them at the top level; `response.failed` nests them under the run it is
 *  reporting on. */
function streamFailureMessage(event: ResponsesEvent): string {
  return (
    event.error?.message ??
    event.response?.error?.message ??
    event.message ??
    "The endpoint gave no reason."
  );
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: ResponsesResource,
  _ctx: ResourceContext,
): Promise<ResponsesModelInstance> {
  return new ResponsesModelInstance(resource);
}

export async function createStream(
  resource: ResponsesResource,
  _ctx: ResourceContext,
): Promise<ResponsesModelStreamInstance> {
  return new ResponsesModelStreamInstance(resource);
}
