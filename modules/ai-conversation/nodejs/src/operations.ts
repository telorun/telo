import { InvokeError, integerInput, isCelTimestamp, type CelTimestamp } from "@telorun/sdk";
import { mintAttachmentId, mintConversationId, mintEntryId } from "./conversation-id.js";
import {
  ERR_CONVERSATION_MESSAGE_NOT_STORABLE,
} from "./conversation-errors.js";
import { holdsBytes } from "./message-storable.js";
import { operation } from "./operation.js";


const DEFAULT_LIMIT = 50;

function limitOf(value: unknown): number {
  return value === undefined ? DEFAULT_LIMIT : (integerInput(value) ?? DEFAULT_LIMIT);
}

function versionOf(value: unknown): number {
  const version = integerInput(value);
  if (version === undefined) throw new TypeError("'version' must be an integer");
  return version;
}

function instantOf(value: unknown, field: string): CelTimestamp {
  if (!isCelTimestamp(value)) throw new TypeError(`'${field}' must be a timestamp`);
  return value;
}

const idsOf = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

export const Create = operation("AiConversation.Create", (store, inputs, ctx) =>
  store.create(
    {
      id: inputs.id ?? mintConversationId(),
      ...(inputs.title === undefined ? {} : { title: inputs.title }),
    },
    ctx,
  ),
);

export const Read = operation("AiConversation.Read", (store, inputs, ctx) =>
  store.read(inputs.conversation, ctx),
);

export const List = operation("AiConversation.List", (store, inputs, ctx) =>
  store.list(
    {
      ...(inputs.query === undefined ? {} : { query: inputs.query }),
      ...(inputs.archived === undefined ? {} : { archived: inputs.archived === true }),
      direction: inputs.direction === "asc" ? "asc" : "desc",
      limit: limitOf(inputs.limit),
      ...(inputs.cursor === undefined ? {} : { cursor: inputs.cursor }),
    },
    ctx,
  ),
);

export const Entries = operation("AiConversation.Entries", (store, inputs, ctx) =>
  store.entries(
    {
      conversation: inputs.conversation,
      ...(inputs.through === undefined ? {} : { through: inputs.through }),
      limit: limitOf(inputs.limit),
      ...(inputs.cursor === undefined ? {} : { cursor: inputs.cursor }),
    },
    ctx,
  ),
);

export const Append = operation("AiConversation.Append", async (store, inputs, ctx) => {
  if (holdsBytes(inputs.message)) {
    throw new InvokeError(
      ERR_CONVERSATION_MESSAGE_NOT_STORABLE,
      "The message holds raw bytes, which a stored transcript cannot keep; refer to media by URI.",
    );
  }
  return store.append(
    {
      conversation: inputs.conversation,
      id: mintEntryId(),
      parent: inputs.parent,
      turn: inputs.turn,
      message: inputs.message,
      attachments: idsOf(inputs.attachments),
    },
    ctx,
  );
});

export const Update = operation("AiConversation.Update", (store, inputs, ctx) =>
  store.update(
    {
      conversation: inputs.conversation,
      version: versionOf(inputs.version),
      ...(inputs.title === undefined ? {} : { title: inputs.title }),
      ...(inputs.archived === undefined ? {} : { archived: inputs.archived }),
    },
    ctx,
  ),
);

export const Admit = operation("AiConversation.Admit", (store, inputs, ctx) =>
  store.admit(
    {
      conversation: inputs.conversation,
      version: versionOf(inputs.version),
      turn: inputs.turn,
      attachments: idsOf(inputs.attachments),
      expiredBefore: instantOf(inputs.expiredBefore, "expiredBefore"),
    },
    ctx,
  ),
);

export const Delete = operation("AiConversation.Delete", async (store, inputs, ctx) => {
  await store.delete(inputs.conversation, ctx);
  return { deleted: true };
});

export const RecordApproval = operation("AiConversation.RecordApproval", (store, inputs, ctx) =>
  store.recordApproval(
    {
      conversation: inputs.conversation,
      turn: inputs.turn,
      id: inputs.id,
      entry: inputs.entry,
      toolCallId: inputs.toolCallId,
      ...(inputs.decision === undefined ? {} : { decision: inputs.decision }),
    },
    ctx,
  ),
);

export const RegisterAttachment = operation("AiConversation.RegisterAttachment", (store, inputs, ctx) =>
  store.registerAttachment(
    {
      id: inputs.id ?? mintAttachmentId(),
      ...(inputs.name === undefined ? {} : { name: inputs.name }),
      ...(inputs.binding === undefined ? {} : { binding: { conversation: inputs.binding.conversation, turn: inputs.binding.turn } }),
    },
    ctx,
  ),
);

export const ReadAttachment = operation("AiConversation.ReadAttachment", (store, inputs, ctx) =>
  store.readAttachment(inputs.attachment, ctx),
);

export const ExpireAttachments = operation("AiConversation.ExpireAttachments", (store, inputs, ctx) =>
  store.expireAttachments(
    { expiredBefore: instantOf(inputs.expiredBefore, "expiredBefore"), limit: limitOf(inputs.limit) },
    ctx,
  ),
);

export const ForgetAttachments = operation("AiConversation.ForgetAttachments", async (store, inputs, ctx) => {
  await store.forgetAttachments({ ids: idsOf(inputs.ids) }, ctx);
  return {};
});
