import {
  InvokeError,
  integerInput,
  isInvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { attachmentKey } from "./chat-ids.js";
import { inputInvalid } from "./chat-refusals.js";
import { isProviding, offeredEntry, type ConversationSpec } from "./conversation-spec.js";
import { operationsOf, type OperationCall } from "./operation-call.js";

const SLOTS = ["detector", "registerAttachment", "blobPut"] as const;

interface WriterResource extends Record<string, unknown> {
  metadata: { name: string; module?: string };
  conversation?: unknown;
}

/**
 * The private controller behind AiChat.PutAttachment: the content is detected
 * before it is stored, held to the offered entry its media type falls within,
 * registered pending — so a file whose bytes never land still expires — and
 * streamed into the blob store under that entry's bound.
 */
class AttachmentWriter implements ResourceInstance {
  private readonly ops: Record<(typeof SLOTS)[number], OperationCall>;
  private readonly label: string;

  constructor(
    private readonly resource: WriterResource,
    private readonly ctx: ResourceContext,
  ) {
    this.label = `AiChat.PutAttachment "${resource.metadata.name}"`;
    this.ops = operationsOf(ctx, resource, "AiChat.PutAttachment", SLOTS);
  }

  private async spec(): Promise<ConversationSpec> {
    const conversation = this.ctx.resolveRef(
      this.resource.conversation,
      isProviding,
      () => `${this.label}: 'conversation'`,
      "AiChat.Conversation",
    );
    return (await conversation.provide()) as ConversationSpec;
  }

  async invoke(
    inputs: { content: unknown; declaredMediaType?: string; name?: string },
    ctx?: InvokeContext,
  ) {
    const spec = await this.spec();
    if (!spec.attachments) {
      throw inputInvalid("This conversation accepts no attachments.", [{ pointer: "/content" }]);
    }
    const detected = await this.ops.detector.invoke(
      { input: inputs.content, ...(inputs.declaredMediaType === undefined ? {} : { declared: inputs.declaredMediaType }) },
      ctx,
    );
    if (detected.mislabelled) {
      throw inputInvalid(
        `The file is not the '${inputs.declaredMediaType}' it was declared as; its content reads as ${detected.mediaType}.`,
        [{ pointer: "/content" }],
      );
    }
    const entry = offeredEntry(spec, detected.mediaType);
    if (!entry) {
      throw inputInvalid(`The conversation does not accept ${detected.mediaType} files.`, [{ pointer: "/content" }]);
    }
    const { id } = await this.ops.registerAttachment.invoke(
      inputs.name !== undefined && inputs.name.length > 0 ? { name: inputs.name } : {},
      ctx,
    );
    let stored: { size: unknown };
    try {
      stored = await this.ops.blobPut.invoke(
        { key: attachmentKey(id), content: detected.output, contentType: detected.mediaType, maxBytes: entry.maxBytes },
        ctx,
      );
    } catch (err) {
      if (isInvokeError(err) && err.code === "ERR_BLOB_TOO_LARGE") {
        throw inputInvalid(`A ${detected.mediaType} file may be at most ${entry.maxBytes} bytes.`, [
          { pointer: "/content" },
        ]);
      }
      throw err;
    }
    const size = integerInput(stored.size);
    if (size === undefined) throw new InvokeError("ERR_CONTRACT_VIOLATION", `${this.label}: the store reported no size.`);
    return { id, mediaType: detected.mediaType, size };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<AttachmentWriter> {
  return new AttachmentWriter(resource, ctx);
}
