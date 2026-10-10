import {
  contentToText,
  isMediaPart,
  isTextPart,
  modelContentUnsupported,
  modelRequestRejected,
  type ContentPart,
  type MediaPart,
  type Message,
  type MessageContent,
  type ModelInvokeInput,
  type ToolDefinition,
} from "@telorun/ai";
import type { InvokeError } from "@telorun/sdk";
import type { HttpRequestInstance } from "./anthropic-endpoint.js";

/**
 * The model contract's call as a Messages API request body.
 *
 * Everything the request alone decides is decided here, before anything is
 * sent: a content part the API cannot carry, a response format, an option that
 * would replace a part of the request this translation builds.
 */

export interface MessagesResource {
  metadata: { name: string; module?: string };
  model: string;
  /** Injected by Phase 5 — the account's base URL and key live on its client. */
  request: HttpRequestInstance;
  maxTokens: number | bigint;
  cacheLifetime?: "5m" | "1h";
  betas?: string[];
  options?: Record<string, unknown>;
}

/** What a model resource publishes of itself. No redaction needed: the key is
 *  the client's, and a credential's own output is marked `x-telo-sensitive`. */
export function publishedConfig(resource: MessagesResource): Record<string, unknown> {
  const { model, maxTokens, cacheLifetime, betas, options } = resource;
  return {
    model,
    maxTokens,
    cacheLifetime: cacheLifetime ?? "5m",
    ...(betas ? { betas } : {}),
    ...(options ? { options } : {}),
  };
}

/** One content block of a request or an answer. */
export type Block = Record<string, unknown>;

interface Turn {
  role: "user" | "assistant";
  content: Block[];
}

/**
 * An assistant turn carried between requests: its content blocks exactly as
 * the endpoint returned them, which is the only form a thinking block's
 * signature survives in.
 *
 * TAGGED, and the tag is checked before replay: blocks minted by one model
 * through one account mean nothing to another, and a transcript legitimately
 * moves between them. The resource is module-qualified, since a resource name
 * is unique only within its module.
 */
export interface MessagesProviderState {
  api: "messages";
  model: string;
  resource: string;
  content: Block[];
}

/** `<module>.<name>`, unique across the application. */
export function qualifiedName(resource: { metadata: { name: string; module?: string } }): string {
  const { module, name } = resource.metadata;
  return module ? `${module}.${name}` : name;
}

/** The API takes at most this many cache breakpoints in one request. */
const MAX_BREAKPOINTS = 4;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF = "application/pdf";
const PLAIN_TEXT = "text/plain";

const TAKES =
  "This endpoint takes text, JPEG, PNG, GIF and WebP images by bytes or by an http(s) URL, " +
  "PDF files by bytes or by an http(s) URL, and plain-text files by bytes.";
const OUTPUT_ONLY = "It is produced by a model, not submitted to one.";
const SYSTEM_TAKES = "A system message takes text only.";

/**
 * The refusal of a well-formed part this API cannot carry. Raised while the
 * request is built: sending the rest would be a request quietly missing part
 * of the message.
 */
function unsupported(label: string, part: ContentPart, takes: string, scheme?: string): InvokeError {
  const mediaType = "mediaType" in part ? part.mediaType : undefined;
  const ofType = mediaType === undefined ? "" : ` of media type '${mediaType}'`;
  const carriage = scheme === undefined ? "" : ` by a '${scheme}:' URI`;
  return modelContentUnsupported(
    `${label}: a '${part.type}' content part${ofType} cannot be sent${carriage}. ${takes}`,
    { partType: part.type, scheme, mediaType },
  );
}

/** A media type without its parameters, lowercased. */
function essence(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Runtime parts carry raw bytes; manifest-authored ones a base64 string. */
function base64Of(data: Uint8Array | string): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

function utf8Of(data: Uint8Array | string): string {
  return (typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data)).toString("utf8");
}

/** A part's `uri` when it is one the endpoint can be handed, exactly as
 *  written — a reference is translated, never fetched. */
function remoteUrl(part: MediaPart, uri: string, label: string): string {
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  if (scheme === "http" || scheme === "https") return uri;
  throw unsupported(label, part, TAKES, scheme);
}

function imageSource(part: MediaPart, label: string): Block {
  const mediaType = essence(part.mediaType);
  if (!IMAGE_TYPES.has(mediaType)) throw unsupported(label, part, TAKES);
  if (part.uri !== undefined) return { type: "url", url: remoteUrl(part, part.uri, label) };
  return { type: "base64", media_type: mediaType, data: base64Of(part.data) };
}

function documentSource(part: MediaPart, label: string): Block {
  const mediaType = essence(part.mediaType);
  if (mediaType === PDF) {
    if (part.uri !== undefined) return { type: "url", url: remoteUrl(part, part.uri, label) };
    return { type: "base64", media_type: PDF, data: base64Of(part.data) };
  }
  // A plain-text document is sent as its text, so it has no by-reference form.
  if (mediaType === PLAIN_TEXT && part.uri === undefined) {
    return { type: "text", media_type: PLAIN_TEXT, data: utf8Of(part.data) };
  }
  throw unsupported(label, part, TAKES);
}

/** One part a caller sends, as the block the API takes it as. */
function translatePart(part: ContentPart, label: string): Block {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", source: imageSource(part, label) };
    case "file":
      return {
        type: "document",
        source: documentSource(part, label),
        ...(part.name === undefined ? {} : { title: part.name }),
      };
    case "audio":
    case "video":
      throw unsupported(label, part, TAKES);
    default:
      throw unsupported(label, part, OUTPUT_ONLY);
  }
}

const wantsBreakpoint = (part: ContentPart): boolean =>
  "cacheBreakpoint" in part && part.cacheBreakpoint === true;

/** The API refuses an empty text block, and one carries nothing. */
const isEmptyText = (part: ContentPart): boolean => part.type === "text" && part.text === "";

/** Blocks, with the ones a caller marked as cache breakpoints. */
class Translation {
  readonly system: Block[] = [];
  readonly turns: Turn[] = [];
  private readonly marked = new Set<Block>();

  mark(block: Block): void {
    this.marked.add(block);
  }

  /** The API honours a limited number of breakpoints, so the last ones in
   *  request order are kept — system first, then the turns — and earlier ones
   *  are dropped. A breakpoint is a hint and never an error. */
  applyBreakpoints(lifetime: "5m" | "1h"): void {
    const inOrder = [...this.system, ...this.turns.flatMap((turn) => turn.content)].filter(
      (block) => this.marked.has(block),
    );
    for (const block of inOrder.slice(-MAX_BREAKPOINTS)) {
      block.cache_control = lifetime === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    }
  }
}

function systemBlocks(content: MessageContent, label: string, out: Translation): void {
  if (typeof content === "string") {
    if (content !== "") out.system.push({ type: "text", text: content });
    return;
  }
  for (const part of content) {
    if (!isTextPart(part)) throw unsupported(label, part, SYSTEM_TAKES);
    if (isEmptyText(part)) continue;
    const block = { type: "text", text: part.text };
    out.system.push(block);
    if (wantsBreakpoint(part)) out.mark(block);
  }
}

function userBlocks(content: MessageContent, label: string, out: Translation): Block[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const blocks: Block[] = [];
  for (const part of content) {
    if (isEmptyText(part)) continue;
    const block = translatePart(part, label);
    blocks.push(block);
    if (wantsBreakpoint(part)) out.mark(block);
  }
  return blocks;
}

/** An assistant turn rebuilt from the contract: its text, then the calls it
 *  made. The parts a model produces beside its text are not sent back — what
 *  must survive verbatim rides the provider state. */
function assistantBlocks(message: Message, out: Translation): Block[] {
  const blocks: Block[] = [];
  if (typeof message.content === "string") {
    if (message.content !== "") blocks.push({ type: "text", text: message.content });
  } else {
    for (const part of message.content) {
      if (!isTextPart(part) || isEmptyText(part)) continue;
      const block = { type: "text", text: part.text };
      blocks.push(block);
      if (wantsBreakpoint(part)) out.mark(block);
    }
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
  }
  return blocks;
}

const isThinking = (block: Block): boolean =>
  block.type === "thinking" || block.type === "redacted_thinking";

/** A carried turn's blocks as they were returned. A breakpoint the message
 *  carries lands on the last block that can hold one: a thinking block cannot. */
function replayedBlocks(message: Message, state: MessagesProviderState, out: Translation): Block[] {
  const blocks = state.content.map((block) => ({ ...block }));
  const marked = typeof message.content !== "string" && message.content.some(wantsBreakpoint);
  const holder = marked ? blocks.filter((block) => !isThinking(block)).at(-1) : undefined;
  if (holder) out.mark(holder);
  return blocks;
}

/**
 * A run of consecutive tool messages as ONE user turn: a result per message,
 * in order, then the files those results returned. A result holds its text and
 * images; a document is not a block a result may hold, so it follows them. A
 * breakpoint on a part inside a result marks the result, which is the block
 * the API caches at.
 */
function toolTurn(run: Message[], label: string, out: Translation): Turn {
  const results: Block[] = [];
  const documents: Block[] = [];
  for (const message of run) {
    const result: Block = { type: "tool_result", tool_use_id: message.toolCallId ?? "" };
    results.push(result);
    const content = message.content;
    if (typeof content === "string") {
      result.content = content;
      continue;
    }
    if (!content.some(isMediaPart)) {
      result.content = contentToText(content);
      if (content.some((part) => isTextPart(part) && wantsBreakpoint(part))) out.mark(result);
      continue;
    }
    const held: Block[] = [];
    for (const part of content) {
      // A part a model produces is left out of a result, not refused.
      if (!isTextPart(part) && !isMediaPart(part)) continue;
      if (isEmptyText(part)) continue;
      const block = translatePart(part, label);
      if (part.type === "file") {
        documents.push(block);
        if (wantsBreakpoint(part)) out.mark(block);
        continue;
      }
      held.push(block);
      if (wantsBreakpoint(part)) out.mark(result);
    }
    if (held.length > 0) result.content = held;
  }
  return { role: "user", content: [...results, ...documents] };
}

function isOwnState(
  state: unknown,
  resource: MessagesResource,
): state is MessagesProviderState {
  const s = state as MessagesProviderState | null | undefined;
  return (
    !!s &&
    typeof s === "object" &&
    s.api === "messages" &&
    s.model === resource.model &&
    s.resource === qualifiedName(resource) &&
    Array.isArray(s.content) &&
    s.content.length > 0 &&
    s.content.every((block) => !!block && typeof block === "object" && !Array.isArray(block))
  );
}

/** The text an answer's blocks hold, as the contract's `text` joins it. */
export function textOfBlocks(blocks: Block[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * Whether a carried turn IS the given assistant message: the same calls under
 * the same ids, in order — and, for a turn that made none, the same non-empty
 * text, since nothing else tells one answer from another.
 */
function isTurnOf(state: MessagesProviderState, message: Message): boolean {
  const carried = state.content.filter((block) => block.type === "tool_use").map((block) => block.id);
  const calls = (message.toolCalls ?? []).map((call) => call.id);
  if (carried.length !== calls.length || carried.some((id, index) => id !== calls[index])) {
    return false;
  }
  if (calls.length > 0) return true;
  // An empty text identifies nothing: a state holding only thinking would
  // otherwise attach to any empty assistant message.
  const text = textOfBlocks(state.content);
  return text !== "" && text === contentToText(message.content);
}

/**
 * Messages → system blocks and turns.
 *
 * Every system message is hoisted, in order, wherever it sits: the API takes
 * the system prompt beside the conversation, not inside it. The provider state
 * replaces the newest assistant message when it is that turn, and is ignored
 * otherwise — a turn that is not the newest one is rebuilt from the contract.
 */
function translateMessages(
  messages: Message[],
  providerState: unknown,
  resource: MessagesResource,
  label: string,
): Translation {
  const out = new Translation();
  const newestAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
  const state = isOwnState(providerState, resource) ? providerState : undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") {
      systemBlocks(message.content, label, out);
      continue;
    }
    if (message.role === "tool") {
      let end = index;
      while (messages[end + 1]?.role === "tool") end++;
      out.turns.push(toolTurn(messages.slice(index, end + 1), label, out));
      index = end;
      continue;
    }
    const content =
      message.role === "user"
        ? userBlocks(message.content, label, out)
        : index === newestAssistant && state && isTurnOf(state, message)
          ? replayedBlocks(message, state, out)
          : assistantBlocks(message, out);
    // A turn with no blocks is refused by the API and carries nothing.
    if (content.length > 0) out.turns.push({ role: message.role, content });
  }
  return out;
}

function buildTools(defs: ToolDefinition[] | undefined): Block[] | undefined {
  if (!defs || defs.length === 0) return undefined;
  return defs.map((def) => ({
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    input_schema: def.parameters,
  }));
}

/** What this translation builds itself, by its name on the wire. An option
 *  naming one would silently replace part of the request. */
const STRUCTURAL = new Set(["model", "messages", "system", "tools", "tool_choice", "stream"]);

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * The merged options as request parameters: the kind's defaults beneath the
 * call's, top-level keys from camelCase to the API's snake_case, values
 * untouched. A call's `maxTokens` is an ordinary parameter here, and overrides
 * the kind's field.
 */
function requestParams(
  resource: MessagesResource,
  options: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...(resource.options ?? {}), ...(options ?? {}) })) {
    const name = snakeCase(key);
    if (STRUCTURAL.has(name)) {
      throw modelRequestRejected(
        `${label}: 'options.${key}' may not be set — the request's '${name}' is built from the ` +
          `call itself, and an option naming it would replace that.`,
      );
    }
    params[name] = value;
  }
  return params;
}

/** The request body of one call, without the `stream` flag. */
export function buildBody(
  resource: MessagesResource,
  input: ModelInvokeInput,
  label: string,
): Record<string, unknown> {
  if (input.responseFormat !== undefined) {
    throw modelRequestRejected(
      `${label}: 'responseFormat' is not supported — this kind cannot make the endpoint ` +
        `enforce an answer's shape, and does not send a request that would ignore one.`,
    );
  }
  const params = requestParams(resource, input.options, label);
  const translated = translateMessages(input.messages, input.providerState, resource, label);
  translated.applyBreakpoints(resource.cacheLifetime ?? "5m");
  const tools = buildTools(input.tools);
  return {
    model: resource.model,
    max_tokens: resource.maxTokens,
    ...(translated.system.length > 0 ? { system: translated.system } : {}),
    messages: translated.turns,
    ...(tools ? { tools } : {}),
    ...params,
    // After the options, so the call's own choice is what is sent. `none`
    // keeps the tools declared and forbids a new call.
    ...(tools && input.toolChoice ? { tool_choice: { type: input.toolChoice } } : {}),
  };
}
