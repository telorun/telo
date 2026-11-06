# Operations

Every operation is an invocable with a `store` slot naming an `AiConversation.Store`. Ids: conversations `cnv_…`, entries `ent_…`, attachments `att_…` (a prefix and 128 random bits in base 62, 22 characters), minted by `Create` and `RegisterAttachment` (unless the caller supplies one) and `Append`. Turn ids (`trn_…`) and approval ids are minted by the caller and stored as given.

A store failure that carries no code of its own is raised as `ERR_CONVERSATION_UNAVAILABLE` (retryable) with the failure as its cause.

## Shapes

- **Header** — `id`, `title` (string or null), `archived`, `turn` (the latest admitted turn id, null before the first), `version` (starts at 1, +1 per `Update` and `Admit`), `createdAt`, `updatedAt` (timestamps; `updatedAt` also moves with every `Append` and `RecordApproval`).
- **Siblings** — `position` (1-based), `count`, `previous`, `next` (neighbouring entry ids in append order, null at the ends). Roots are siblings of each other.
- **Entry row** — `id`, `parent` (null for a root), `sequence` (append order within the conversation, unique, never a timestamp), `depth` (a root is 1), `turn` (the turn that appended it), `createdAt`, `message` (an `Ai.Message`), `siblings`, and on `Entries` rows `approvals`.
- **Approval** — `id`, `toolCallId`, `requestedAt`, `decision`: null while pending, else `{ approved, reason?, decidedAt, turn }` (the deciding turn).
- **Attachment** — `id`, `conversation` (null while pending), `name` (null when none was given), `createdAt`, `boundAt` (null while pending).

## Operations

| Operation | Inputs | Output | Codes |
| --- | --- | --- | --- |
| `Create` | `title?`, `id?` (a caller-minted `cnv_…` id; an existing one answers its header unchanged) | Header | — |
| `Read` | `conversation` | Header | `ERR_CONVERSATION_NOT_FOUND` |
| `List` | `query?` (title contains, case-insensitive), `archived?` (true lists only archived ones, false only active ones, absent both), `direction?` (`desc` newest first, the default, or `asc`), `limit?` (1–500, 50), `cursor?` (valid only for the direction it was read in) | `{ rows: Header[], total, next }` | `ERR_CONVERSATION_CURSOR_INVALID` |
| `Entries` | `conversation`, `through?`, `limit?` (1–500, 50), `cursor?` | `{ rows: EntryRow[], total, next }` | `NOT_FOUND`, `ERR_CONVERSATION_ENTRY_NOT_FOUND`, `CURSOR_INVALID` |
| `Append` | `conversation`, `parent` (entry id or null for a root), `turn`, `message`, `attachments?` (ids bound with the entry) | the entry (with `siblings`) | `NOT_FOUND`, `ENTRY_NOT_FOUND` (parent), `ERR_CONVERSATION_CONFLICT`, `ERR_CONVERSATION_MESSAGE_NOT_STORABLE`, `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` |
| `Update` | `conversation`, `version`, and at least one of `title`, `archived` | new Header | `NOT_FOUND`, `ERR_CONVERSATION_CONFLICT` |
| `Admit` | `conversation`, `version`, `turn`, `attachments`, `expiredBefore` (a timestamp) | new Header | `NOT_FOUND`, `ERR_CONVERSATION_CONFLICT`, `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` (`data: { attachment }`) |
| `Delete` | `conversation` | `{ deleted: true }` | `NOT_FOUND` |
| `RegisterAttachment` | `id?`, `name?`, `binding?` `{ conversation, turn }` | Attachment (pending; bound with `binding`) | `NOT_FOUND`, `ERR_CONVERSATION_CONFLICT` (with `binding`), `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` (an existing `id`) |
| `ReadAttachment` | `attachment` | Attachment | `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` |
| `ExpireAttachments` | `expiredBefore`, `limit?` (1–500, 50) | `{ ids }` | — |
| `ForgetAttachments` | `ids` | `{}` | — |
| `RecordApproval` | `conversation`, `turn`, `id`, `entry`, `toolCallId`, `decision?` `{ approved, reason? }` | Approval | `NOT_FOUND`, `ENTRY_NOT_FOUND`, `ERR_CONVERSATION_TOOL_CALL_NOT_FOUND`, `ERR_CONVERSATION_CONFLICT` |

## Rules

- **Turn fence.** `Admit` admits a turn and supersedes the previous one. `Append` and `RecordApproval` must name the header's current turn; any other, or a conversation with no admitted turn, is `ERR_CONVERSATION_CONFLICT`. The store keeps no claim and no expiry: whether a turn is alive is judged by its journal key.
- **Version.** `Update` and `Admit` are conditional on `version`; of two at one version exactly one succeeds. `Append` is not, so a rename during a turn does not refuse its appends.
- **Attachments.** A file is registered before its bytes are stored. Registered pending, it belongs to no conversation, and the first write that makes a conversation refer to it binds it, in the same transaction: `Admit` for the files a turn's message names, `Append` for those its entry carries. Either may name a pending file or one the conversation already holds; `Admit` also refuses a pending file registered before `expiredBefore`, so an expired upload is refused whether or not an expiry pass has run. Any other is `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` and the whole write is rolled back. Registered with `binding`, a file a running turn produces is its conversation's from the start, fenced on that turn as `Append` is — a superseded turn registers nothing — so it is readable as soon as its bytes are stored and no expiry pass reaches it. A caller-supplied `id` that already exists answers its record only while it is unreleased and as the call would have left it, and is `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` otherwise, so an id never answers another conversation's file. `Delete` releases the conversation's files in its own transaction, after which every one reads as not found. `ExpireAttachments` releases expired pending files and returns released ones; the caller removes their bytes, then `ForgetAttachments` deletes their records.
- **Branches.** `Entries` returns the branch from the root down to `through`, then below it by the most recently appended child at each step down to a leaf; without `through`, the latest branch, ending at the conversation's most recently appended entry. Rows run leaf to root (newest first) within and across pages; `next` continues toward the root; `total` is the branch length. The cursor is opaque and resumes above the last row returned; repeat `through` with it so `total` is read from the same branch.
- **Approvals.** `RecordApproval` without a `decision` records the request (repeating it changes nothing); with one it decides, once — a second decision, or an `id` naming another call, is `ERR_CONVERSATION_CONFLICT`. `toolCallId` must be a tool call of the entry's message. An `Append` beneath an entry with an undecided approval is `ERR_CONVERSATION_CONFLICT`.
- **Messages** are stored as JSON; one holding raw bytes is `ERR_CONVERSATION_MESSAGE_NOT_STORABLE` — refer to media by URI.

## Mapping to the conversation contract

A stored entry maps to `Conversation.Entry` (module `conversation`): `id`, `parent`, `turn`, `siblings` as they are; `role`, `parts`, `toolCalls`, `toolResults` from `message` (`content` a string becomes one text part, `toolCalls[].id/name/arguments` as they are); each tool call's `approval` is `{ id, decision }` from the `approvals` row with the same `toolCallId` (absent when none), `decision` mapped to `{ approved, reason? }`. `Header` maps to `ConversationSummary` (`running` is the server's: the journal of `turn` decides).
