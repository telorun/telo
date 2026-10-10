import {
  modelFailureFromError,
  modelResponseInvalid,
  modelToolArgumentsInvalid,
  type StreamPart,
} from "@telorun/ai";
import type { InvokeContext } from "@telorun/sdk";
import { readSseRecords } from "@telorun/sse-codec";
import { reportedFailure, vendorErrorOf } from "./anthropic-failure.js";
import type { Block, MessagesResource } from "./messages-request.js";
import {
  mapFinishReason,
  mapUsage,
  namedBlock,
  providerStateOf,
  toolCallOf,
  type MessagesUsage,
} from "./messages-response.js";

/**
 * A streamed Messages API answer as the model contract's parts.
 *
 * The API sends an answer as events that build it block by block. Each block
 * is assembled here into the form a buffered answer carries it in, so a tool
 * call, the usage figures, the stop reason and the state carried to the next
 * request are read by the same rules whichever way the answer arrived.
 */

/** The most payload one event may hold, and the bound the frame reader applies
 *  to a line on its own. */
const MAX_FRAME_BYTES = 1 << 20;

/**
 * The body's chunks, with a read that breaks raised as what it is. A body that
 * breaks after a success status is the same fact as one that ends early — an
 * answer that cannot be read to its end — unless the caller cancelled, which
 * stays a cancellation. Stopping early returns the source, so the transport is
 * told nobody is reading.
 */
async function* bodyChunks(
  body: AsyncIterable<unknown>,
  label: string,
  ctx: InvokeContext | undefined,
): AsyncGenerator<unknown> {
  const source = body[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      let step: IteratorResult<unknown>;
      try {
        step = await source.next();
      } catch (err) {
        finished = true;
        throw modelFailureFromError(err, ctx, (broke) =>
          modelResponseInvalid(
            `${label}: the response body broke before the answer was complete. ` +
              `${broke instanceof Error ? broke.message : String(broke)}`,
            { cause: broke },
          ),
        );
      }
      if (step.done) {
        finished = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!finished) await source.return?.();
  }
}

/**
 * The events of a streamed answer, each as its decoded JSON object.
 *
 * Frames are found by the shared reader, under its line bound and this module's
 * frame bound. What the reader refuses — an overrun, a chunk that is not bytes —
 * is an answer that cannot be read, as is a frame that is not a JSON object.
 */
async function* events(
  body: AsyncIterable<unknown>,
  label: string,
  ctx: InvokeContext | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const records = readSseRecords(bodyChunks(body, label, ctx), label, {
    maxFrameBytes: MAX_FRAME_BYTES,
  });
  try {
    while (true) {
      let step: IteratorResult<{ data: string }>;
      try {
        step = await records.next();
      } catch (err) {
        // The body's own break arrives here already raised as what it is, and
        // passes; what the reader itself refuses is an unreadable answer.
        throw modelFailureFromError(err, ctx, (refused) =>
          modelResponseInvalid(
            `${label}: the stream cannot be read. ` +
              `${refused instanceof Error ? refused.message : String(refused)}`,
            { cause: refused },
          ),
        );
      }
      if (step.done) return;
      yield decodeEvent(step.value.data, label);
    }
  } finally {
    // Returns the reader, and through it the body, when the consumer stopped
    // before the end; a reader that already ended ignores it.
    await records.return(undefined);
  }
}

function decodeEvent(data: string, label: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (err) {
    throw modelResponseInvalid(`${label}: a stream frame is not JSON.`, { cause: err });
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw modelResponseInvalid(`${label}: a stream frame is not a JSON object.`);
  }
  return decoded as Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A block being built, with the input text it has received so far. */
interface OpenBlock {
  block: Block;
  /** The block's input as the JSON text written so far. A tool call the caller
   *  runs is written this way, and so is any other block that takes an input. */
  json: string;
  open: boolean;
}

/** The figures of a later event over the earlier ones: the opening event
 *  reports the input, the closing one the output, and either may repeat the
 *  other's. A figure reported as null says nothing. */
function mergeUsage(into: Record<string, unknown>, reported: unknown): void {
  if (!isRecord(reported)) return;
  for (const [key, value] of Object.entries(reported)) {
    if (value !== null && value !== undefined) into[key] = value;
  }
}

/**
 * The parts of one streamed answer, in the contract's order: deltas as they are
 * written, each tool call whole once its block closes, the state to carry when
 * the answer needs one, then the one `finish`.
 *
 * The answer is complete on a `message_delta` carrying a stop reason — the
 * endpoint's statement that it is — or on the `message_stop` trailer. Reading
 * goes on after the stop reason, to the trailer or the body's end, so a failure
 * reported in that window still wins. A body that ends with neither is an
 * interrupted answer, never a clean stop. Every failure rejects the iteration.
 */
export async function* streamParts(
  body: AsyncIterable<unknown>,
  resource: MessagesResource,
  label: string,
  ctx: InvokeContext | undefined,
): AsyncGenerator<StreamPart> {
  const blocks = new Map<number, OpenBlock>();
  const usage: Record<string, unknown> = {};
  let stopReason: unknown;

  const malformed = (what: string): Error =>
    modelResponseInvalid(`${label}: the stream ${what}, so the answer cannot be read.`);

  const blockAt = (event: Record<string, unknown>): OpenBlock => {
    const entry = typeof event.index === "number" ? blocks.get(event.index) : undefined;
    if (!entry || !entry.open) {
      throw malformed(`carries a '${String(event.type)}' event for a content block it never opened`);
    }
    return entry;
  };

  /** Close a block. Only here is the input text it was sent whole JSON, so
   *  only here does it become the block's `input` — on any block that was sent
   *  one, so the carried state holds what a buffered answer would. A tool call
   *  the caller runs is complete here, and is the one block reported as a call. */
  function* close(entry: OpenBlock): Generator<StreamPart> {
    entry.open = false;
    const { block } = entry;
    const isToolCall = block.type === "tool_use";
    if (entry.json.trim() !== "") {
      try {
        block.input = JSON.parse(entry.json);
      } catch (err) {
        if (!isToolCall) {
          throw modelResponseInvalid(
            `${label}: the stream carries a '${String(block.type)}' block whose input is not ` +
              `valid JSON, so the answer cannot be read: ${entry.json.slice(0, 200)}`,
            { cause: err },
          );
        }
        const name = typeof block.name === "string" && block.name !== "" ? block.name : "(unnamed)";
        throw modelToolArgumentsInvalid(
          `${label}: the model asked for tool '${name}' with arguments that are not valid JSON: ` +
            `${entry.json.slice(0, 200)}`,
          { tool: name },
          { cause: err },
        );
      }
    }
    if (isToolCall) yield { type: "tool-call", toolCall: toolCallOf(block, label) };
  }

  /** The end of an accepted answer: blocks still open are closed in order,
   *  then the state to carry, then the one `finish`. */
  async function* complete(): AsyncGenerator<StreamPart> {
    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
    for (const entry of ordered) {
      if (entry.open) yield* close(entry);
    }
    const state = providerStateOf(
      ordered.map((entry) => entry.block),
      resource,
    );
    if (state) yield { type: "provider-state", providerState: state };
    yield {
      type: "finish",
      usage: mapUsage(usage as MessagesUsage),
      finishReason: mapFinishReason(stopReason),
    };
  }

  for await (const event of events(body, label, ctx)) {
    // A failure the endpoint reports inside the stream wins over anything
    // beside it, whatever the event calls itself.
    const failed = vendorErrorOf(event);
    if (failed || event.type === "error") {
      throw reportedFailure(label, "the endpoint failed mid-stream", failed);
    }
    if (typeof event.type !== "string") throw malformed("carries an event with no 'type'");

    switch (event.type) {
      case "message_start": {
        if (isRecord(event.message)) mergeUsage(usage, event.message.usage);
        break;
      }
      case "content_block_start": {
        if (typeof event.index !== "number" || !isRecord(event.content_block)) {
          throw malformed("opens a content block without an index or a block");
        }
        // A call is named before its first argument fragment, so its deltas
        // and the call agree.
        const block: Block = namedBlock({ ...event.content_block });
        blocks.set(event.index, { block, json: "", open: true });
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          yield { type: "text-delta", delta: block.text };
        }
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
          yield { type: "reasoning-delta", delta: block.thinking };
        }
        break;
      }
      case "content_block_delta": {
        const entry = blockAt(event);
        const { block } = entry;
        const delta = isRecord(event.delta) ? event.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
          if (delta.text !== "") yield { type: "text-delta", delta: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
          if (delta.thinking !== "") yield { type: "reasoning-delta", delta: delta.thinking };
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = delta.signature;
        } else if (delta.type === "citations_delta" && delta.citation !== undefined) {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          entry.json += delta.partial_json;
          // Only a call the caller runs is reported while it is written; a
          // delta with no call to follow it would name a call that never comes.
          if (block.type === "tool_use" && delta.partial_json !== "") {
            yield {
              type: "tool-call-delta",
              toolCallId: block.id as string,
              toolName: typeof block.name === "string" ? block.name : "",
              delta: delta.partial_json,
            };
          }
        }
        // A delta of a kind not read here changes nothing this module reports.
        break;
      }
      case "content_block_stop": {
        yield* close(blockAt(event));
        break;
      }
      case "message_delta": {
        if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
          stopReason = event.delta.stop_reason;
        }
        mergeUsage(usage, event.usage);
        break;
      }
      case "message_stop": {
        // Nothing follows the trailer; leaving returns the body.
        yield* complete();
        return;
      }
      default:
        // `ping`, and any event the API adds later: nothing to report.
        break;
    }
  }

  // The body ended cleanly without the trailer. An answer the endpoint
  // declared finished is not thrown away for that; one it never declared
  // finished is an interrupted answer, and `finish` would render it a clean stop.
  if (stopReason === undefined) {
    throw malformed("ended with neither a stop reason nor its closing 'message_stop' event");
  }
  yield* complete();
}
