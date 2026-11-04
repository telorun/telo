# Conversations and attachments

> Examples assume this module is imported as `Chat` (the module is named `AiChat`, and the alias must differ from that for now).

## Reading and changing conversations

| Kind | Input | Output | Codes |
| --- | --- | --- | --- |
| `ListConversations` | `titleContains?`, `archived?` (absent lists both), `sort?` (`updatedAt` or `-updatedAt`, the default), `limit?` (1–100, 25), `cursor?` | `ConversationPage` | `ERR_CONVERSATION_CURSOR_INVALID` (store) |
| `ReadConversation` | `id` | `ConversationSummary` | `ERR_CONVERSATION_NOT_FOUND` |
| `ConversationEntries` | `id`, `through?`, `limit?`, `cursor?` | `EntryPage` | `ERR_CONVERSATION_NOT_FOUND`, `ERR_CONVERSATION_ENTRY_NOT_FOUND` (store) |
| `UpdateConversation` | `id`, `title?` / `archived?` | `ConversationSummary` | `ERR_CONVERSATION_NOT_FOUND`, `ERR_CONVERSATION_CONFLICT` |
| `DeleteConversation` | `id` | `{}` | `ERR_CONVERSATION_NOT_FOUND` |

- A summary's `running` is judged by the journal: true only while a read of the
  latest turn's key, after its stale-writer rule, finds it open.
- An entry maps from the stored row: `id`, `parent`, `turn`, `siblings` as stored;
  `role`, `parts` and `toolCalls` from the message, each tool call carrying
  `approval: { id, decision }` when it needed one. A tool message is an assistant
  entry with `parts: []` and `toolResults: [{ id, result }]`, `result` what the model
  was told. Media read as `conversations/<id>/attachments/<attachment id>`.
- `UpdateConversation` applies the change at the version just read, re-reading on a
  conflict at most three times; a running turn is not disturbed.
- `DeleteConversation` asks the running turn to stop (`RecordStream.JournalCancel`,
  without waiting), then deletes the conversation, which releases every file it
  holds — uploaded or produced — in the same write. None is readable afterwards, and
  `Chat.AttachmentExpiry` removes their bytes ([where files live](conversation.md#where-files-live)).
  Another conversation's files are never touched: a file is held by one conversation.
- `ListConversations` judges each row's `running` with one journal read of its latest
  turn, one after another, so a page costs its `limit` reads; keep `limit` modest.

## Attachments

### `Chat.PutAttachment`

Input `{ content, declaredMediaType?, name? }` — `content` bytes or a stream of them.
Output `Attachment`, `{ id, mediaType, size }`. The file is pending: it has no
address until a turn sends it.

1. The content's leading bytes are read by the detector. A declared type the bytes
   contradict is refused.
2. Its media type must fall within an offered type of the conversation's spec — an
   exact type or a whole one (`image/*`).
3. It is registered pending in the store, with its `name`.
4. It is streamed into the file store under that type's `maxBytes`, so an oversized
   upload stores nothing and reads at most one chunk past the bound; its record
   expires with the other unsent uploads.

Each refusal — no attachments offered, a contradicted type, a type outside the offer,
too large — is `ERR_INPUT_INVALID` at `/content`, naming the type or the bound. The
`name` is kept in the file's record and handed to the model with it.

### `Chat.GetAttachment`

Input `{ conversation, id }` (an `att_…` id); output `{ content, mediaType, size }`,
`content` the stored bytes as a stream. A file the conversation does not hold —
unknown, pending, deleted, or another conversation's — is
`ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` with `data: { attachment }`. So is a file
whose record was read but whose bytes were not there when they were read: a delete
and an expiry pass landed in between, or the file is one a turn produced whose bytes
are still being stored or failed to be.

### `Chat.AttachmentExpiry`

Input `{}`; output `{ count }`, the files the pass removed. See
[removing files](conversation.md#removing-files).

### `Chat.Capabilities`

Input `{}`; output the conversation's `Conversation.Spec`, also published as its
reading (`resources.<name>.attachments`, `.operations`).
