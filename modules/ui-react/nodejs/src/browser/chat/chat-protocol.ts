import type { Host } from "../host.js";
import { issuePlace, issueText, problemOf } from "../problem-details.js";
import { underMount } from "../renderer-context.js";
import { findingText, type Say } from "../texts.js";
import { requestErrorOf, unansweredError } from "../ui-error.js";
import { validate, type JsonSchema } from "../validation.js";

/** What an endpoint offers before any event arrives, as the node carries it. */
export interface ChatSpec {
  attachments?: { accepts: { type: "image" | "audio" | "video" | "file"; mediaTypes: string[]; maxBytes: number }[]; maxPerMessage: number };
  operations: string[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** A completed part of a message. A part of a type this renderer does not know is kept and not drawn. */
export type Part =
  | { type: "text" | "reasoning" | "refusal"; text: string }
  | { type: "image" | "audio" | "video" | "file"; url: string; mediaType: string; name?: string; size?: number }
  | { type: "citation"; url: string; title?: string; quote?: string }
  | { type: string; [member: string]: unknown };

/** Where an entry stands among those sharing its parent, in append order. */
export interface Siblings {
  position: number;
  count: number;
  previous: string | null;
  next: string | null;
}

/** The decision a tool call waited for: absent while pending. */
export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface Entry {
  id: string;
  parent: string | null;
  turn: string;
  siblings: Siblings;
  role: "user" | "assistant";
  parts: Part[];
  toolCalls?: { id: string; name: string; arguments: unknown; approval?: { id: string; decision: ApprovalDecision | null } }[];
  toolResults?: { id: string; result: unknown; isError?: boolean }[];
  usage?: Usage;
}

export type TurnEndReason = "stop" | "length" | "content-filter" | "limit" | "approval" | "cancelled" | "failed";

/** An event of a turn. One of a type this renderer does not know is ignored. */
export type ChatEvent =
  | { type: "text-delta" | "reasoning-delta"; text: string }
  | { type: "content"; part: Part }
  | { type: "tool-call-delta"; id: string; name?: string; argumentsDelta: string }
  | { type: "tool-call"; id: string; name: string; arguments: unknown }
  | { type: "tool-result"; id: string; result: unknown; isError?: boolean }
  | { type: "approval-request"; id: string; toolCallId: string; name: string; arguments: unknown }
  | { type: "approval-decision"; id: string; approved: boolean; reason?: string }
  | { type: "step-usage"; usage: Usage }
  | { type: "turn-end"; reason: TurnEndReason; usage?: Usage }
  | { type: "error"; code: string; detail: string }
  | { type: string; [member: string]: unknown };

export interface ConversationSummary {
  id: string;
  title: string | null;
  archived: boolean;
  updatedAt: string;
  /** The latest admitted turn. */
  turn: string | null;
  /** Whether that turn is still open. */
  running: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
  next: string | null;
}

/** An upload's answer. It has no address: a file is read only under the conversation that sent it. */
export interface Attachment {
  id: string;
  mediaType: string;
  size: number;
}

export interface TurnRequest {
  conversation?: string;
  /** Absent: the latest branch continues. Null: a new root. */
  parent?: string | null;
  message: string;
  attachments: string[];
  approvals?: { id: string; approved: boolean; reason?: string }[];
}

/** A failed request: the problem's `code` and `detail`, or what the failure stands for. */
export class ChatFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Absent when nothing answered. */
    readonly status?: number,
  ) {
    super(message);
  }

  /** Whether asking again may succeed: nothing answered, or the server failed. */
  get transient(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}

/** A refused request as it reads: the findings worded with the validation texts a form's are, else the problem's own. */
export function problemFailure(status: number, body: unknown, say: Say): ChatFailure {
  const problem = problemOf(body);
  if (problem.issues.length > 0) {
    const message = problem.issues
      .map((issue) => {
        const why = say(issueText(issue).key, issueText(issue).values);
        const where = issuePlace(issue).path.join(".");
        return where ? `${where}: ${why}` : why;
      })
      .join("; ");
    return new ChatFailure(problem.code ?? "ERR_INPUT_INVALID", message, status);
  }
  const error = requestErrorOf(status, body, say);
  return new ChatFailure(error.code as string, error.message as string, status);
}

const text = { type: "string" };
const page = (row: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["rows", "total", "next"],
  properties: { rows: { type: "array", items: row }, total: { type: "integer" }, next: { type: ["string", "null"] } },
});

const SCHEMAS: Record<string, JsonSchema> = {
  started: { type: "object", required: ["conversation", "turn"], properties: { conversation: text, turn: text } },
  summary: {
    type: "object",
    required: ["id", "title", "archived", "turn", "running"],
    properties: { id: text, title: { type: ["string", "null"] }, archived: { type: "boolean" }, turn: { type: ["string", "null"] }, running: { type: "boolean" } },
  },
  entries: page({
    type: "object",
    required: ["id", "parent", "turn", "siblings", "role", "parts"],
    properties: {
      id: text,
      parent: { type: ["string", "null"] },
      turn: text,
      siblings: {
        type: "object",
        required: ["position", "count", "previous", "next"],
        properties: { position: { type: "integer" }, count: { type: "integer" }, previous: { type: ["string", "null"] }, next: { type: ["string", "null"] } },
      },
      role: { enum: ["user", "assistant"] },
      parts: { type: "array", items: { type: "object", required: ["type"], properties: { type: text } } },
    },
  }),
  attachment: { type: "object", required: ["id", "mediaType", "size"], properties: { id: text, mediaType: text, size: { type: "integer" } } },
  event: { type: "object", required: ["type"], properties: { type: text } },
};

/** A body the contract refuses, as the failure it is. */
export function invalidAnswer(findings: ReturnType<typeof validate>, say: Say): ChatFailure {
  return new ChatFailure("ERR_UI_RESPONSE_INVALID", say("answerNotModel", { detail: findingText(findings[0], say) }));
}

/** One frame's data read as an event; a frame that is no event is a body the contract refuses. */
export function readEvent(data: string, say: Say): ChatEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ChatFailure("ERR_UI_RESPONSE_INVALID", say("answerNotJson"));
  }
  const findings = validate(SCHEMAS.event, parsed);
  if (findings.length > 0) throw invalidAnswer(findings, say);
  return parsed as ChatEvent;
}

/** Requests to one conversation endpoint, through the host's fetch, under the node's `basePath`. */
export class ChatApi {
  constructor(
    private readonly host: () => Host,
    readonly prefix: string,
    readonly basePath: string,
    private readonly say: Say,
  ) {}

  /** The address a path of the endpoint is requested at. */
  url(path: string): string {
    return underMount(this.prefix, this.basePath + path);
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.host().fetch(this.url(path), init);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      const failed = unansweredError(error, this.say);
      throw new ChatFailure(failed.code as string, failed.message as string);
    }
    if (response.ok) return response;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A body that is not JSON: the status alone is the report.
    }
    throw problemFailure(response.status, body, this.say);
  }

  private async answer<T>(path: string, schema: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ChatFailure("ERR_UI_RESPONSE_INVALID", this.say("answerNotJson"), response.status);
    }
    const findings = validate(SCHEMAS[schema], body);
    if (findings.length > 0) throw invalidAnswer(findings, this.say);
    return body as T;
  }

  startTurn(request: TurnRequest, key: string): Promise<{ conversation: string; turn: string }> {
    return this.answer("/turns", "started", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(request),
    });
  }

  async cancelTurn(turn: string): Promise<void> {
    await this.fetch(`/turns/${encodeURIComponent(turn)}/cancel`, { method: "POST" });
  }

  /** One conversation's summary: its latest turn and whether that turn is open. */
  conversation(conversation: string, signal?: AbortSignal): Promise<ConversationSummary> {
    return this.answer(`/conversations/${encodeURIComponent(conversation)}`, "summary", { signal });
  }

  /** One page of a branch's transcript, newest first. `through` chooses the branch; absent, the latest. */
  entriesPage(conversation: string, query: { through?: string; cursor?: string | null }, signal?: AbortSignal): Promise<Page<Entry>> {
    const params = new URLSearchParams({ limit: "100" });
    if (query.through) params.set("through", query.through);
    if (query.cursor) params.set("cursor", query.cursor);
    return this.answer(`/conversations/${encodeURIComponent(conversation)}/entries?${params}`, "entries", { signal });
  }

  /** An upload's response, held to the contract. */
  attachmentOf(body: unknown): Attachment {
    const findings = validate(SCHEMAS.attachment, body);
    if (findings.length > 0) throw invalidAnswer(findings, this.say);
    return body as Attachment;
  }

  /** The stream of a turn's events, resumed after `lastId`. Resolves when the server ends it. */
  async events(turn: string, lastId: string | undefined, signal: AbortSignal, onFrame: (id: string | undefined, event: ChatEvent) => void): Promise<void> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastId !== undefined) headers["last-event-id"] = lastId;
    const response = await this.fetch(`/turns/${encodeURIComponent(turn)}/events`, { headers, signal });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let id: string | undefined;
    const line = (value: string) => {
      if (value === "") {
        // A chunk read just before the abort belongs to a stream nobody is reading any more.
        if (signal.aborted) throw new DOMException("The stream was closed.", "AbortError");
        if (data.length > 0) onFrame(id, readEvent(data.join("\n"), this.say));
        data = [];
        return;
      }
      if (value.startsWith(":")) return;
      const colon = value.indexOf(":");
      const field = colon === -1 ? value : value.slice(0, colon);
      const content = colon === -1 ? "" : value.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(content);
      else if (field === "id" && !content.includes("\0")) id = content;
    };
    const lines = (final: boolean) => {
      // A carriage return ending a chunk may be the first half of a CRLF: it waits for the next.
      const held = !final && buffer.endsWith("\r") ? "\r" : "";
      const parts = buffer.slice(0, buffer.length - held.length).split(/\r\n|\n|\r/);
      buffer = final ? "" : (parts.pop() as string) + held;
      for (const each of parts) line(each);
    };
    try {
      if (!reader) {
        // A response that is not a stream is read whole.
        buffer = await response.text();
        return lines(true);
      }
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += decoder.decode(chunk.value, { stream: true });
        lines(false);
      }
      buffer += decoder.decode();
      lines(true);
    } catch (error) {
      if (signal.aborted || error instanceof ChatFailure) throw error;
      // A connection that broke mid-body is a dropped stream, resumed by the caller.
      return;
    }
  }
}
